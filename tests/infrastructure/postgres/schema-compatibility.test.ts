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

const diagnosticMetadata = {
  backend_pid: '4312',
  database_oid: '5',
  ledger_table_oid: '19452',
  is_recovery: false,
} as const;

function diagnosticResult(
  entries: readonly { readonly version: string; readonly name: string }[],
): QueryResult<QueryResultRow> {
  const rows: QueryResultRow[] =
    entries.length === 0
      ? [{ ...diagnosticMetadata, version: null, name: null }]
      : entries.map((entry) => ({ ...diagnosticMetadata, ...entry }));
  return result(rows);
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
      readFile('db/security/slack_onboarding_grants.sql', 'utf8'),
      readFile('db/security/slack_runtime_credential_grants.sql', 'utf8'),
    ]);

    for (const script of grantScripts) {
      expect(script).toMatch(
        /GRANT SELECT ON TABLE\s+public\.schema_migrations,/u,
      );
    }
  });

  it('accepts every required migration and allows later additive migrations', async () => {
    const query = vi.fn().mockResolvedValue(
      diagnosticResult(
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
      expect.stringContaining('WITH connection_metadata AS'),
      [REQUIRED_SCHEMA_MIGRATIONS.at(-1)?.version],
    );
    expect(query.mock.calls[0]?.[0]).toContain('FROM public.schema_migrations');
  });

  it('fails closed when a required migration is missing or renamed', async () => {
    const missingQuery = vi
      .fn()
      .mockResolvedValue(
        diagnosticResult(REQUIRED_SCHEMA_MIGRATIONS.slice(0, -1)),
      );
    const renamedQuery = vi.fn().mockResolvedValue(
      diagnosticResult(
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
      diagnostic: {
        backendPid: diagnosticMetadata.backend_pid,
        databaseOid: diagnosticMetadata.database_oid,
        ledgerTableOid: diagnosticMetadata.ledger_table_oid,
        expectedMigrationCount: REQUIRED_SCHEMA_MIGRATIONS.length,
        actualMigrationCount: REQUIRED_SCHEMA_MIGRATIONS.length - 1,
      },
    });
    await expect(
      assertDatabaseSchemaCompatible({
        query: renamedQuery,
      } as Pick<Pool, 'query'>),
    ).rejects.toMatchObject({
      code: 'SCHEMA_MIGRATION_IDENTITY_MISMATCH',
      diagnostic: {
        mismatch: {
          mismatchPosition: 1,
          expectedVersion: '1',
          expectedName: '0001_initial.sql',
          actualVersion: '1',
          actualName: '0001_renamed.sql',
          actualNameByteLength: Buffer.byteLength('0001_renamed.sql'),
          actualNameUtf8Hex: Buffer.from('0001_renamed.sql').toString('hex'),
          actualNameUtf8HexTruncated: false,
        },
      },
    });
  });

  it('hex-encodes an unsafe migration name instead of logging it directly', async () => {
    const unsafeName = '0001_initial.sql\nforged-log-entry';
    const query = vi.fn().mockResolvedValue(
      diagnosticResult(
        REQUIRED_SCHEMA_MIGRATIONS.map(({ version, name }, index) => ({
          version,
          name: index === 0 ? unsafeName : name,
        })),
      ),
    );

    let compatibilityError: DatabaseSchemaCompatibilityError | undefined;
    try {
      await assertDatabaseSchemaCompatible({
        query,
      });
    } catch (error) {
      if (error instanceof DatabaseSchemaCompatibilityError) {
        compatibilityError = error;
      }
    }

    expect(compatibilityError).toMatchObject({
      code: 'SCHEMA_MIGRATION_IDENTITY_MISMATCH',
      diagnostic: {
        mismatch: {
          actualNameByteLength: Buffer.byteLength(unsafeName),
          actualNameUtf8Hex: Buffer.from(unsafeName).toString('hex'),
        },
      },
    });
    expect(compatibilityError?.diagnostic?.mismatch).not.toHaveProperty(
      'actualName',
    );
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
