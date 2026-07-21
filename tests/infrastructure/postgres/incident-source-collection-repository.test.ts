import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { IncidentSourceCollection } from '../../../src/application/ports/incident-source-collection-repository.js';
import { PostgresIncidentSourceCollectionRepository } from '../../../src/infrastructure/postgres/incident-source-collection-repository.js';

const now = new Date('2026-07-21T04:49:44.000Z');
const tenantId = 'T001';
const incidentId = '00000000-0000-4000-8000-000000000001';
const sourceId = '00000000-0000-4000-8000-000000000002';
const runId = '00000000-0000-4000-8000-000000000003';

describe('PostgresIncidentSourceCollectionRepository', () => {
  it('uses one explicit timestamp for initial collection rows', async () => {
    const query = vi.fn((text: string, _values?: readonly unknown[]) => {
      if (text.includes('SELECT source_kind')) {
        return Promise.resolve({
          rows: [
            {
              source_kind: 'SLACK_CHANNEL',
              requested_start_at: now,
              requested_end_at: new Date(now.getTime() + 60_000),
              status: 'PLANNED',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('SELECT id FROM source_collection_runs')) {
        return Promise.resolve({ rows: [{ id: runId }], rowCount: 1 });
      }
      if (text.includes('FROM incident_sources source')) {
        return Promise.resolve({
          rows: [
            {
              tenant_id: tenantId,
              incident_id: incidentId,
              source_id: sourceId,
              run_id: runId,
              workspace_id: tenantId,
              channel_id: 'C001',
              source_kind: 'SLACK_CHANNEL',
              display_name: null,
              requested_start_at: now,
              requested_end_at: new Date(now.getTime() + 60_000),
              anchor_thread_timestamps: [],
              discovered_thread_timestamps: [],
              status: 'COLLECTING',
              phase: 'CHANNEL',
              anchor_index: 0,
              collection_cursor: null,
              pages_collected: 0,
              collected_message_count: 0,
              rate_limit_count: 0,
              transient_failure_count: 0,
              checkpoint_version: 0,
              retention_days: 30,
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as unknown as Pool;

    const repository = new PostgresIncidentSourceCollectionRepository(pool);
    await repository.getOrCreate(tenantId, incidentId, sourceId, runId, now);

    const inserts = query.mock.calls.filter(([text]) =>
      String(text).includes('INSERT INTO source_'),
    );
    expect(inserts).toHaveLength(3);
    expect(inserts[0]?.[1]?.at(-1)).toBe(now);
    expect(inserts[1]?.[1]?.at(-1)).toBe(now);
    expect(inserts[2]?.[1]?.at(-1)).toBe(now);
    expect(String(inserts[0]?.[0])).toContain(
      'requested_end_at, started_at, created_at, updated_at',
    );
    expect(String(inserts[0]?.[0])).toContain('$8, $8, $8)');
    expect(String(inserts[1]?.[0])).toContain(
      'source_id, run_id, phase, created_at, updated_at',
    );
    expect(String(inserts[1]?.[0])).toContain('$5, $6, $6)');
    expect(String(inserts[2]?.[0])).toContain(
      'requested_start_at, requested_end_at, created_at, updated_at',
    );
    expect(String(inserts[2]?.[0])).toContain('$4, $5, $6, $6)');
  });

  it('atomically persists discovered thread roots with the page checkpoint', async () => {
    const discovered = ['1721458860.000200'];
    const checkpointUpdates: unknown[][] = [];
    const collection: IncidentSourceCollection = {
      tenantId,
      incidentId,
      sourceId,
      runId,
      workspaceId: tenantId,
      channelId: 'C001',
      sourceKind: 'SLACK_CHANNEL',
      displayName: 'incident-checkout',
      requestedStartAt: now,
      requestedEndAt: new Date(now.getTime() + 60_000),
      anchorThreadTimestamps: [],
      discoveredThreadTimestamps: [],
      status: 'COLLECTING',
      phase: 'CHANNEL',
      anchorIndex: 0,
      cursor: null,
      pagesCollected: 0,
      messagesCollected: 0,
      rateLimitCount: 0,
      transientFailureCount: 0,
      checkpointVersion: 0,
      retentionDays: 30,
    };
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      if (text.includes('SELECT count(*)::integer')) {
        return Promise.resolve({ rows: [{ count: 0 }], rowCount: 1 });
      }
      if (text.includes('UPDATE source_collection_checkpoints')) {
        checkpointUpdates.push([...(values ?? [])]);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('FROM incident_sources source')) {
        return Promise.resolve({
          rows: [
            {
              tenant_id: tenantId,
              incident_id: incidentId,
              source_id: sourceId,
              run_id: runId,
              workspace_id: tenantId,
              channel_id: 'C001',
              source_kind: 'SLACK_CHANNEL',
              display_name: 'incident-checkout',
              requested_start_at: now,
              requested_end_at: new Date(now.getTime() + 60_000),
              anchor_thread_timestamps: [],
              discovered_thread_timestamps: discovered,
              status: 'COLLECTING',
              phase: 'ANCHOR_THREAD',
              anchor_index: 0,
              collection_cursor: null,
              pages_collected: 1,
              collected_message_count: 0,
              rate_limit_count: 0,
              transient_failure_count: 0,
              checkpoint_version: 1,
              retention_days: 30,
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as unknown as Pool;
    const repository = new PostgresIncidentSourceCollectionRepository(pool);

    await expect(
      repository.advance({
        collection,
        messages: [],
        nextPhase: 'ANCHOR_THREAD',
        nextAnchorIndex: 0,
        nextCursor: null,
        nextDiscoveredThreadTimestamps: discovered,
        completed: false,
        observedAt: now,
      }),
    ).resolves.toMatchObject({
      discoveredThreadTimestamps: discovered,
      phase: 'ANCHOR_THREAD',
    });
    expect(checkpointUpdates).toHaveLength(1);
    expect(checkpointUpdates[0]?.[3]).toEqual(discovered);
  });
});
