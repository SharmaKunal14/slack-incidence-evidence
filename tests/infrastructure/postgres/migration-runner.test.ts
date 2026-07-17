import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  MigrationIntegrityError,
  runMigrations,
} from '../../../src/infrastructure/postgres/migration-runner.js';

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

function poolWithAppliedRows(appliedRows: readonly QueryResultRow[]): {
  readonly pool: Pool;
  readonly query: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn((sql: string): Promise<QueryResult<QueryResultRow>> => {
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
  return { pool, query, release };
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
      applied: ['0001_initial.sql'],
      alreadyApplied: 0,
    });

    expect(query).toHaveBeenCalledWith('SELECT pg_advisory_lock($1::bigint)', [
      expect.any(String),
    ]);
    expect(query).toHaveBeenCalledWith('BEGIN');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE tenants'),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO schema_migrations'),
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
});
