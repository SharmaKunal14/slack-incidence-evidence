import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { OptimisticConcurrencyError } from '../../../src/application/ports/incident-repository.js';
import type { Incident } from '../../../src/domain/incident.js';
import {
  IncidentPersistenceError,
  PostgresIncidentRepository,
} from '../../../src/infrastructure/postgres/incident-repository.js';

const incident: Incident = {
  id: 'incident-1',
  tenantId: 'T001',
  sourceEventId: 'Ev001',
  sourceWorkspaceId: 'T001',
  sourceChannelId: 'C001',
  sourceThreadTs: '1721177900.000050',
  requestedByUserId: 'U001',
  title: 'Checkout outage',
  status: 'DISCOVERED',
  severity: 'UNCLASSIFIED',
  startedAt: null,
  resolvedAt: null,
  createdAt: new Date('2026-07-17T01:00:00.000Z'),
  updatedAt: new Date('2026-07-17T01:00:00.000Z'),
  version: 0,
};

const incidentRow = {
  id: incident.id,
  tenant_id: incident.tenantId,
  source_event_id: incident.sourceEventId,
  source_workspace_id: incident.sourceWorkspaceId,
  source_channel_id: incident.sourceChannelId,
  source_thread_ts: incident.sourceThreadTs ?? null,
  requested_by_user_id: incident.requestedByUserId,
  title: incident.title,
  status: incident.status,
  severity: incident.severity,
  started_at: incident.startedAt,
  resolved_at: incident.resolvedAt,
  created_at: incident.createdAt,
  updated_at: incident.updatedAt,
  version: incident.version,
};

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

function repositoryWithClient(
  queryResults: readonly QueryResult<QueryResultRow>[],
): {
  readonly repository: PostgresIncidentRepository;
  readonly query: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn();
  for (const queryResult of queryResults) {
    query.mockResolvedValueOnce(queryResult);
  }
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return { repository: new PostgresIncidentRepository(pool), query, release };
}

describe('PostgresIncidentRepository', () => {
  it('creates a new incident in one transaction', async () => {
    const { repository, query, release } = repositoryWithClient([
      result([]),
      result([]),
      result([incidentRow]),
      result([]),
    ]);

    await expect(repository.createIfAbsent(incident)).resolves.toEqual({
      created: true,
      incident,
    });

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO tenants'),
      ['T001', 'Slack workspace T001'],
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining(
        'ON CONFLICT (tenant_id, source_event_id) DO NOTHING',
      ),
      expect.arrayContaining(['incident-1', 'T001', 'Ev001']),
    );
    expect(query).toHaveBeenNthCalledWith(4, 'COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('returns the winner when a repeated Slack event races with another delivery', async () => {
    const { repository, query } = repositoryWithClient([
      result([]),
      result([]),
      result([]),
      result([incidentRow]),
      result([]),
    ]);

    await expect(repository.createIfAbsent(incident)).resolves.toEqual({
      created: false,
      incident,
    });

    expect(query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('source_event_id = $2'),
      ['T001', 'Ev001'],
    );
  });

  it('uses the tenant and expected version in an optimistic update', async () => {
    const query = vi.fn().mockResolvedValue(result([], 1));
    const pool = { query } as unknown as Pool;
    const repository = new PostgresIncidentRepository(pool);
    const collecting: Incident = {
      ...incident,
      status: 'COLLECTING',
      version: 1,
      updatedAt: new Date('2026-07-17T01:01:00.000Z'),
    };

    await expect(repository.save(collecting, 0)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('AND version = $10'),
      expect.arrayContaining(['T001', 'incident-1', 0]),
    );
  });

  it('rejects both stale writes and malformed aggregate versions', async () => {
    const query = vi.fn().mockResolvedValue(result([], 0));
    const repository = new PostgresIncidentRepository({
      query,
    } as unknown as Pool);
    const collecting: Incident = {
      ...incident,
      status: 'COLLECTING',
      version: 1,
    };

    await expect(repository.save(collecting, 0)).rejects.toBeInstanceOf(
      OptimisticConcurrencyError,
    );
    await expect(repository.save(collecting, 2)).rejects.toBeInstanceOf(
      IncidentPersistenceError,
    );
  });
});
