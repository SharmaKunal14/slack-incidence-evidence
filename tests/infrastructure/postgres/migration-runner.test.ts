import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  MigrationIntegrityError,
  runMigrations,
} from '../../../src/infrastructure/postgres/migration-runner.js';
import { REQUIRED_SCHEMA_MIGRATIONS } from '../../../src/infrastructure/postgres/schema-compatibility.js';

function result<Row extends QueryResultRow>(
  rows: Row[],
  rowCount = rows.length,
): QueryResult<Row> {
  return {
    command: '',
    fields: [],
    oid: 0,
    rowCount,
    rows,
  };
}

function poolWithAppliedRows(
  appliedRows: readonly QueryResultRow[],
  diagnosticRows: readonly QueryResultRow[] = [],
): {
  readonly pool: Pool;
  readonly query: ReturnType<typeof vi.fn>;
  readonly queriedSql: readonly string[];
  readonly release: ReturnType<typeof vi.fn>;
} {
  const queriedSql: string[] = [];
  const query = vi.fn((sql: string): Promise<QueryResult<QueryResultRow>> => {
    queriedSql.push(sql);
    if (sql.includes('WITH connection_metadata AS')) {
      return Promise.resolve(result([...diagnosticRows]));
    }
    if (sql.includes('SELECT version::text')) {
      return Promise.resolve(result([...appliedRows]));
    }
    return Promise.resolve(result([]));
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return { pool, query, queriedSql, release };
}

function expectedLedgerIdentityHash(
  migrations: readonly { readonly version: string; readonly name: string }[],
): string {
  const hash = createHash('sha256');
  for (const migration of migrations) {
    hash.update(migration.version, 'utf8');
    hash.update('\0');
    hash.update(migration.name, 'utf8');
    hash.update('\0');
  }
  return hash.digest('hex');
}

describe('runMigrations', () => {
  it('serializes and transactionally records pending migrations', async () => {
    const { pool, query, release } = poolWithAppliedRows([]);

    await expect(
      runMigrations(pool, {
        migrationsDirectory: 'db/migrations',
        appliedBy: 'test-suite',
      }),
    ).resolves.toEqual({
      applied: [
        '0001_initial.sql',
        '0002_slack_thread_collection.sql',
        '0003_incident_analysis.sql',
        '0004_incident_report_drafts.sql',
        '0005_human_review.sql',
        '0006_approved_report_publication.sql',
        '0007_configurable_report_publisher.sql',
        '0008_review_question_answers.sql',
        '0009_multi_channel_incident_sources.sql',
        '0010_auto_discovered_slack_threads.sql',
        '0011_evidence_linked_review_content.sql',
        '0012_slack_oauth_onboarding.sql',
        '0013_slack_enterprise_user_ids.sql',
        '0014_slack_secret_arn_constraint.sql',
        '0015_slack_installation_disconnection.sql',
        '0016_workspace_roles_and_invitations.sql',
      ],
      alreadyApplied: 0,
    });

    expect(query).toHaveBeenCalledWith('SELECT pg_advisory_lock($1::bigint)', [
      expect.any(String),
    ]);
    expect(query).toHaveBeenCalledWith('BEGIN');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        'CREATE TABLE IF NOT EXISTS public.schema_migrations',
      ),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM public.schema_migrations'),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE tenants'),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE slack_thread_collections'),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE incident_analysis_runs'),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE incident_report_drafts'),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE reviewer_memberships'),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE slack_oauth_authorizations'),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE workspace_invitations'),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE report_publications'),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ADD COLUMN publisher TEXT'),
    );
    for (const table of [
      'incident_sources',
      'source_collection_runs',
      'source_collection_checkpoints',
      'source_coverage_manifests',
    ]) {
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining(`CREATE TABLE ${table}`),
      );
    }
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO public.schema_migrations'),
      expect.arrayContaining([
        '1',
        '0001_initial.sql',
        expect.any(String),
        'test-suite',
      ]),
    );
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1::bigint)',
      [expect.any(String)],
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('refuses to run when an applied migration checksum no longer matches', async () => {
    const { pool, query, release } = poolWithAppliedRows([
      {
        version: '1',
        name: '0001_initial.sql',
        checksum: '0'.repeat(64),
      },
    ]);

    await expect(
      runMigrations(pool, { migrationsDirectory: 'db/migrations' }),
    ).rejects.toBeInstanceOf(MigrationIntegrityError);

    expect(query).not.toHaveBeenCalledWith('BEGIN');
    expect(query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1::bigint)',
      [expect.any(String)],
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('captures a bounded post-migration ledger diagnostic before unlocking', async () => {
    const diagnosticRows = REQUIRED_SCHEMA_MIGRATIONS.map(
      ({ version, name }) => ({
        backend_pid: '4312',
        database_oid: '5',
        ledger_table_oid: '19452',
        is_recovery: false,
        version,
        name,
      }),
    );
    const { pool, query, queriedSql } = poolWithAppliedRows([], diagnosticRows);
    const logger = { info: vi.fn() };

    await runMigrations(pool, {
      migrationsDirectory: 'db/migrations',
      appliedBy: 'test-suite',
      logger,
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        migrationLedgerDiagnostic: {
          backendPid: '4312',
          databaseOid: '5',
          ledgerTableOid: '19452',
          isRecovery: false,
          ledgerEntryCount: REQUIRED_SCHEMA_MIGRATIONS.length,
          ledgerIdentityHash: expectedLedgerIdentityHash(
            REQUIRED_SCHEMA_MIGRATIONS,
          ),
        },
      },
      'PostgreSQL post-migration ledger snapshot captured',
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WITH connection_metadata AS'),
      [REQUIRED_SCHEMA_MIGRATIONS.at(-1)?.version],
    );

    const diagnosticCall = queriedSql.findIndex((sql) =>
      sql.includes('WITH connection_metadata AS'),
    );
    const unlockCall = queriedSql.findIndex((sql) =>
      sql.includes('pg_advisory_unlock'),
    );
    expect(diagnosticCall).toBeGreaterThanOrEqual(0);
    expect(unlockCall).toBeGreaterThan(diagnosticCall);
  });
});
