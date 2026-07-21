import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  readMigrationLedgerSnapshot,
  summarizeMigrationLedgerSnapshot,
} from '../../../src/infrastructure/postgres/migration-ledger-diagnostic.js';

function result<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return {
    command: 'SELECT',
    fields: [],
    oid: 0,
    rowCount: rows.length,
    rows,
  };
}

describe('migration ledger diagnostics', () => {
  it('attributes an ordered ledger hash to the same database backend', async () => {
    const query = vi.fn().mockResolvedValue(
      result([
        {
          backend_pid: '4312',
          database_oid: '5',
          ledger_table_oid: '19452',
          is_recovery: false,
          version: '1',
          name: '0001_initial.sql',
        },
        {
          backend_pid: '4312',
          database_oid: '5',
          ledger_table_oid: '19452',
          is_recovery: false,
          version: '2',
          name: '0002_second.sql',
        },
      ]),
    );

    const snapshot = await readMigrationLedgerSnapshot({ query }, '10');

    expect(snapshot).toMatchObject({
      backendPid: '4312',
      databaseOid: '5',
      ledgerTableOid: '19452',
      isRecovery: false,
      entries: [
        { version: '1', name: '0001_initial.sql' },
        { version: '2', name: '0002_second.sql' },
      ],
    });
    expect(snapshot.ledgerIdentityHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(summarizeMigrationLedgerSnapshot(snapshot)).not.toHaveProperty(
      'entries',
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('LEFT JOIN ledger ON TRUE'),
      ['10'],
    );
  });

  it('represents an empty ledger without losing connection metadata', async () => {
    const query = vi.fn().mockResolvedValue(
      result([
        {
          backend_pid: '4312',
          database_oid: '5',
          ledger_table_oid: '19452',
          is_recovery: false,
          version: null,
          name: null,
        },
      ]),
    );

    const snapshot = await readMigrationLedgerSnapshot({ query }, '10');

    expect(snapshot.entries).toEqual([]);
    expect(snapshot.ledgerIdentityHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects inconsistent backend metadata instead of misattributing rows', async () => {
    const query = vi.fn().mockResolvedValue(
      result([
        {
          backend_pid: '4312',
          database_oid: '5',
          ledger_table_oid: '19452',
          is_recovery: false,
          version: '1',
          name: '0001_initial.sql',
        },
        {
          backend_pid: '9876',
          database_oid: '5',
          ledger_table_oid: '19452',
          is_recovery: false,
          version: '2',
          name: '0002_second.sql',
        },
      ]),
    );

    await expect(readMigrationLedgerSnapshot({ query }, '10')).rejects.toThrow(
      'Inconsistent migration ledger diagnostic metadata',
    );
  });
});
