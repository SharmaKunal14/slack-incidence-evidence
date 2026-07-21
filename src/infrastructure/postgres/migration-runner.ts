import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import {
  readMigrationLedgerSnapshot,
  summarizeMigrationLedgerSnapshot,
} from './migration-ledger-diagnostic.js';

const MIGRATION_FILE_PATTERN =
  /^(?<version>[0-9]+)_(?<description>[a-z0-9_]+)\.sql$/;

// This lock is scoped to one PostgreSQL database and one physical connection.
// A stable, project-specific key makes independently started API/worker releases
// serialize schema changes without requiring a separate coordination service.
const DEFAULT_ADVISORY_LOCK_KEY = '6839005176042471';

const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version BIGINT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum CHAR(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    execution_time_ms INTEGER NOT NULL CHECK (execution_time_ms >= 0),
    applied_by TEXT NOT NULL
  )
`;

interface MigrationLogger {
  info(bindings: Record<string, unknown>, message: string): void;
}

interface MigrationFile {
  readonly version: bigint;
  readonly versionText: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

interface AppliedMigrationRow {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationRunnerOptions {
  readonly migrationsDirectory?: string;
  readonly advisoryLockKey?: string;
  readonly appliedBy?: string;
  readonly logger?: MigrationLogger;
}

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
}

export class InvalidMigrationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidMigrationError';
  }
}

export class MigrationIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MigrationIntegrityError';
  }
}

function checksum(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

async function loadMigrationFiles(
  directory: string,
): Promise<readonly MigrationFile[]> {
  const directoryEntries = await readdir(directory, { withFileTypes: true });
  const migrations: MigrationFile[] = [];

  for (const entry of directoryEntries) {
    if (!entry.isFile()) {
      continue;
    }

    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (match?.groups === undefined) {
      if (entry.name.endsWith('.sql')) {
        throw new InvalidMigrationError(
          `Migration file ${entry.name} must match N_description.sql`,
        );
      }
      continue;
    }

    const versionText = match.groups['version'];
    if (versionText === undefined) {
      throw new InvalidMigrationError(
        `Migration file ${entry.name} has no version`,
      );
    }

    const version = BigInt(versionText);
    if (version <= 0n) {
      throw new InvalidMigrationError(
        `Migration file ${entry.name} must have a positive version`,
      );
    }

    const path = resolve(directory, entry.name);
    const sql = await readFile(path, 'utf8');
    if (sql.trim().length === 0) {
      throw new InvalidMigrationError(`Migration file ${entry.name} is empty`);
    }

    migrations.push({
      version,
      versionText: version.toString(),
      name: entry.name,
      sql,
      checksum: checksum(sql),
    });
  }

  migrations.sort((left, right) =>
    left.version < right.version ? -1 : left.version > right.version ? 1 : 0,
  );

  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1];
    const current = migrations[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.version === current.version
    ) {
      throw new InvalidMigrationError(
        `Migrations ${previous.name} and ${current.name} use the same version`,
      );
    }
  }

  return migrations;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The original migration failure carries the actionable context. A broken
    // connection releases its transaction and advisory lock when discarded.
  }
}

function verifyAppliedMigrations(
  files: readonly MigrationFile[],
  appliedRows: readonly AppliedMigrationRow[],
): ReadonlySet<string> {
  const filesByVersion = new Map(files.map((file) => [file.versionText, file]));

  for (const row of appliedRows) {
    const file = filesByVersion.get(row.version);
    if (file === undefined) {
      throw new MigrationIntegrityError(
        `Applied migration ${row.version} (${row.name}) is missing from the release`,
      );
    }
    if (file.name !== row.name) {
      throw new MigrationIntegrityError(
        `Applied migration ${row.version} was renamed from ${row.name} to ${file.name}`,
      );
    }
    if (file.checksum !== row.checksum.trim()) {
      throw new MigrationIntegrityError(
        `Applied migration ${row.version} (${row.name}) was modified after execution`,
      );
    }
  }

  const appliedVersions = new Set(appliedRows.map((row) => row.version));
  const highestAppliedVersion = appliedRows.reduce<bigint | null>(
    (highest, row) => {
      const version = BigInt(row.version);
      return highest === null || version > highest ? version : highest;
    },
    null,
  );

  if (highestAppliedVersion !== null) {
    const retroactiveMigration = files.find(
      (file) =>
        file.version < highestAppliedVersion &&
        !appliedVersions.has(file.versionText),
    );
    if (retroactiveMigration !== undefined) {
      throw new MigrationIntegrityError(
        `Migration ${retroactiveMigration.name} was added below already-applied version ${highestAppliedVersion.toString()}`,
      );
    }
  }

  return appliedVersions;
}

async function applyMigration(
  client: PoolClient,
  migration: MigrationFile,
  appliedBy: string,
): Promise<number> {
  const startedAt = performance.now();
  await client.query('BEGIN');
  try {
    // Migration files are trusted release artifacts, not user-controlled input.
    await client.query(migration.sql);
    const executionTimeMs = Math.max(
      0,
      Math.round(performance.now() - startedAt),
    );
    await client.query(
      `
        INSERT INTO public.schema_migrations (
          version,
          name,
          checksum,
          execution_time_ms,
          applied_by
        )
        VALUES ($1::bigint, $2, $3, $4, $5)
      `,
      [
        migration.versionText,
        migration.name,
        migration.checksum,
        executionTimeMs,
        appliedBy,
      ],
    );
    await client.query('COMMIT');
    return executionTimeMs;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

/**
 * Applies immutable SQL migrations in version order.
 *
 * Checksums turn an accidentally edited historical migration into a startup
 * failure instead of silent schema drift. The session-level advisory lock is
 * held by one checked-out client for the complete run.
 */
export async function runMigrations(
  pool: Pool,
  options: MigrationRunnerOptions = {},
): Promise<MigrationRunResult> {
  const migrationsDirectory = resolve(
    options.migrationsDirectory ?? resolve(process.cwd(), 'db/migrations'),
  );
  const migrations = await loadMigrationFiles(migrationsDirectory);
  const advisoryLockKey = options.advisoryLockKey ?? DEFAULT_ADVISORY_LOCK_KEY;
  if (!/^-?[0-9]+$/.test(advisoryLockKey)) {
    throw new InvalidMigrationError(
      'The advisory lock key must be a signed bigint',
    );
  }

  const appliedBy = options.appliedBy ?? `${hostname()}:${process.pid}`;
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [
      advisoryLockKey,
    ]);
    lockAcquired = true;
    await client.query(CREATE_MIGRATIONS_TABLE_SQL);

    const appliedResult = await client.query<AppliedMigrationRow>(`
      SELECT version::text, name, checksum
      FROM public.schema_migrations
      ORDER BY version
    `);
    const appliedVersions = verifyAppliedMigrations(
      migrations,
      appliedResult.rows,
    );
    const applied: string[] = [];

    for (const migration of migrations) {
      if (appliedVersions.has(migration.versionText)) {
        continue;
      }

      const executionTimeMs = await applyMigration(
        client,
        migration,
        appliedBy,
      );
      applied.push(migration.name);
      options.logger?.info(
        {
          migration: migration.name,
          version: migration.versionText,
          executionTimeMs,
        },
        'PostgreSQL migration applied',
      );
    }

    if (options.logger !== undefined) {
      const latestMigrationVersion = migrations.at(-1)?.versionText ?? '0';
      const snapshot = await readMigrationLedgerSnapshot(
        client,
        latestMigrationVersion,
      );
      options.logger.info(
        {
          migrationLedgerDiagnostic: summarizeMigrationLedgerSnapshot(snapshot),
        },
        'PostgreSQL post-migration ledger snapshot captured',
      );
    }

    return { applied, alreadyApplied: appliedVersions.size };
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [
          advisoryLockKey,
        ]);
      } catch {
        // Releasing the checked-out connection below also releases session locks.
      }
    }
    client.release();
  }
}
