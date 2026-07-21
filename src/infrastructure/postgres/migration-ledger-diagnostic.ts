import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';

interface MigrationLedgerDiagnosticRow extends QueryResultRow {
  readonly backend_pid: string;
  readonly database_oid: string;
  readonly ledger_table_oid: string;
  readonly is_recovery: boolean;
  readonly version: string | null;
  readonly name: string | null;
}

export interface MigrationLedgerEntry {
  readonly version: string;
  readonly name: string;
}

export interface MigrationLedgerSnapshot {
  readonly backendPid: string;
  readonly databaseOid: string;
  readonly ledgerTableOid: string;
  readonly isRecovery: boolean;
  readonly entries: readonly MigrationLedgerEntry[];
  readonly ledgerIdentityHash: string;
}

export interface MigrationLedgerSnapshotSummary {
  readonly backendPid: string;
  readonly databaseOid: string;
  readonly ledgerTableOid: string;
  readonly isRecovery: boolean;
  readonly ledgerEntryCount: number;
  readonly ledgerIdentityHash: string;
}

function requireUnsignedInteger(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new Error(`Invalid ${field} in migration ledger diagnostic result`);
  }
  return value;
}

function ledgerIdentityHash(entries: readonly MigrationLedgerEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    // PostgreSQL text cannot contain NUL, so this delimiter is unambiguous.
    hash.update(entry.version, 'utf8');
    hash.update('\0');
    hash.update(entry.name, 'utf8');
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Reads connection identity and the ordered migration ledger in one statement.
 * Keeping both in one statement makes the diagnostic attributable to the exact
 * backend and snapshot that supplied the migration identities.
 */
export async function readMigrationLedgerSnapshot(
  database: Pick<Pool, 'query'>,
  maximumVersion: string,
): Promise<MigrationLedgerSnapshot> {
  if (!/^[0-9]+$/.test(maximumVersion)) {
    throw new Error('Migration diagnostic maximum version must be unsigned');
  }

  const result = await database.query<MigrationLedgerDiagnosticRow>(
    `
      WITH connection_metadata AS (
        SELECT
          pg_backend_pid()::text AS backend_pid,
          (
            SELECT oid::text
            FROM pg_database
            WHERE datname = current_database()
          ) AS database_oid,
          'public.schema_migrations'::regclass::oid::text AS ledger_table_oid,
          pg_is_in_recovery() AS is_recovery
      ),
      ledger AS (
        SELECT version, name
        FROM public.schema_migrations
        WHERE version <= $1::bigint
      )
      SELECT
        connection_metadata.backend_pid,
        connection_metadata.database_oid,
        connection_metadata.ledger_table_oid,
        connection_metadata.is_recovery,
        ledger.version::text AS version,
        ledger.name
      FROM connection_metadata
      LEFT JOIN ledger ON TRUE
      ORDER BY ledger.version NULLS LAST
    `,
    [maximumVersion],
  );

  const first = result.rows[0];
  if (first === undefined || typeof first.is_recovery !== 'boolean') {
    throw new Error('Invalid migration ledger diagnostic result');
  }

  const backendPid = requireUnsignedInteger(first.backend_pid, 'backend PID');
  const databaseOid = requireUnsignedInteger(
    first.database_oid,
    'database OID',
  );
  const ledgerTableOid = requireUnsignedInteger(
    first.ledger_table_oid,
    'ledger table OID',
  );
  const entries: MigrationLedgerEntry[] = [];

  for (const row of result.rows) {
    if (
      row.backend_pid !== backendPid ||
      row.database_oid !== databaseOid ||
      row.ledger_table_oid !== ledgerTableOid ||
      row.is_recovery !== first.is_recovery
    ) {
      throw new Error('Inconsistent migration ledger diagnostic metadata');
    }
    if (row.version === null && row.name === null) {
      continue;
    }
    if (row.version === null || typeof row.name !== 'string') {
      throw new Error('Invalid migration ledger identity result');
    }
    entries.push({
      version: requireUnsignedInteger(row.version, 'migration version'),
      name: row.name,
    });
  }

  return {
    backendPid,
    databaseOid,
    ledgerTableOid,
    isRecovery: first.is_recovery,
    entries,
    ledgerIdentityHash: ledgerIdentityHash(entries),
  };
}

export function summarizeMigrationLedgerSnapshot(
  snapshot: MigrationLedgerSnapshot,
): MigrationLedgerSnapshotSummary {
  return {
    backendPid: snapshot.backendPid,
    databaseOid: snapshot.databaseOid,
    ledgerTableOid: snapshot.ledgerTableOid,
    isRecovery: snapshot.isRecovery,
    ledgerEntryCount: snapshot.entries.length,
    ledgerIdentityHash: snapshot.ledgerIdentityHash,
  };
}
