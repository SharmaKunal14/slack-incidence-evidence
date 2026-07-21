import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  assertDatabaseSchemaCompatible,
  DatabaseSchemaCompatibilityError,
  REQUIRED_SCHEMA_MIGRATIONS,
} from '../../../src/infrastructure/postgres/schema-compatibility.js';

function result<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return {
    command: 'SELECT',
    fields: [],
    oid: 0,
    rowCount: rows.length,
    rows,
  };
}

describe('database schema compatibility', () => {
  it('keeps the compiled contract aligned with every checked-in migration', async () => {
    const filenames = (await readdir('db/migrations'))
      .filter((filename) => filename.endsWith('.sql'))
      .sort();

    expect(REQUIRED_SCHEMA_MIGRATIONS.map(({ name }) => name)).toEqual(
      filenames,
    );
  });

  it('allows least-privilege database processes to inspect migration state', async () => {
    const grantScripts = await Promise.all([
      readFile('db/security/review_api_grants.sql', 'utf8'),
      readFile('db/security/publication_worker_grants.sql', 'utf8'),
    ]);

    for (const script of grantScripts) {
      expect(script).toMatch(
        /GRANT SELECT ON TABLE\s+public\.schema_migrations,/u,
      );
    }
  });

  it('accepts every required migration and allows later additive migrations', async () => {
    const query = vi.fn().mockResolvedValue(
      result(
        REQUIRED_SCHEMA_MIGRATIONS.map(({ version, name }) => ({
          version,
          name,
        })),
      ),
    );
    const database = { query } as unknown as Pick<Pool, 'query'>;

    await expect(assertDatabaseSchemaCompatible(database)).resolves.toBe(
      undefined,
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM public.schema_migrations'),
      [REQUIRED_SCHEMA_MIGRATIONS.at(-1)?.version],
    );
    expect(query.mock.calls[0]?.[0]).toContain('version <= $1::bigint');
  });

  it('fails closed when a required migration is missing or renamed', async () => {
    const missingQuery = vi
      .fn()
      .mockResolvedValue(result(REQUIRED_SCHEMA_MIGRATIONS.slice(0, -1)));
    const renamedQuery = vi.fn().mockResolvedValue(
      result(
        REQUIRED_SCHEMA_MIGRATIONS.map(({ version, name }, index) => ({
          version,
          name: index === 0 ? '0001_renamed.sql' : name,
        })),
      ),
    );

    await expect(
      assertDatabaseSchemaCompatible({
        query: missingQuery,
      } as Pick<Pool, 'query'>),
    ).rejects.toMatchObject({
      code: 'SCHEMA_MIGRATION_COUNT_MISMATCH',
    });
    await expect(
      assertDatabaseSchemaCompatible({
        query: renamedQuery,
      } as Pick<Pool, 'query'>),
    ).rejects.toMatchObject({
      code: 'SCHEMA_MIGRATION_IDENTITY_MISMATCH',
    });
  });

  it('does not expose a database error through the compatibility boundary', async () => {
    const database = {
      query: vi.fn().mockRejectedValue(new Error('sensitive connection data')),
    } as unknown as Pick<Pool, 'query'>;

    await expect(assertDatabaseSchemaCompatible(database)).rejects.toEqual(
      new DatabaseSchemaCompatibilityError('SCHEMA_QUERY_FAILED'),
    );
  });
});
