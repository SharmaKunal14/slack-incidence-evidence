import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  SlackThreadCollectionConcurrencyError,
  type SlackThreadCollection,
} from '../../../src/application/ports/slack-thread-collection-repository.js';
import { PostgresSlackThreadCollectionRepository } from '../../../src/infrastructure/postgres/slack-thread-collection-repository.js';

const collection: SlackThreadCollection = {
  tenantId: 'T001',
  incidentId: '2c6a2f4a-f762-41e9-9620-a07abdaa5c48',
  workspaceId: 'T001',
  channelId: 'C001',
  threadTs: '1721178000.000100',
  status: 'RUNNING',
  nextCursor: null,
  messagesCollected: 0,
  pagesCollected: 0,
  failureCode: null,
  version: 0,
};

const collectionRow = {
  tenant_id: collection.tenantId,
  incident_id: collection.incidentId,
  workspace_id: collection.workspaceId,
  channel_id: collection.channelId,
  thread_ts: collection.threadTs,
  status: collection.status,
  next_cursor: collection.nextCursor,
  messages_collected: collection.messagesCollected,
  pages_collected: collection.pagesCollected,
  failure_code: collection.failureCode,
  version: collection.version,
};

function result<Row extends QueryResultRow>(
  rows: Row[],
  rowCount = rows.length,
): QueryResult<Row> {
  return { command: '', fields: [], oid: 0, rowCount, rows };
}

function repositoryWithClient(
  queryResults: readonly QueryResult<QueryResultRow>[],
): {
  readonly repository: PostgresSlackThreadCollectionRepository;
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
  return {
    repository: new PostgresSlackThreadCollectionRepository(pool),
    query,
    release,
  };
}

describe('PostgresSlackThreadCollectionRepository', () => {
  it('creates a durable checkpoint from the triggering Slack message', async () => {
    const { repository, query, release } = repositoryWithClient([
      result([]),
      result([
        {
          source_workspace_id: 'T001',
          source_channel_id: 'C001',
          source_message_ts: '1721178000.000100',
          source_thread_ts: null,
        },
      ]),
      result([]),
      result([collectionRow]),
      result([]),
    ]);

    await expect(
      repository.getOrCreate(collection.tenantId, collection.incidentId),
    ).resolves.toEqual(collection);

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining(
        'ON CONFLICT (tenant_id, incident_id) DO NOTHING',
      ),
      [
        collection.tenantId,
        collection.incidentId,
        collection.workspaceId,
        collection.channelId,
        collection.threadTs,
      ],
    );
    expect(query).toHaveBeenNthCalledWith(5, 'COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('upserts artifacts and advances the checkpoint in the same transaction', async () => {
    const completedRow = {
      ...collectionRow,
      status: 'COMPLETE',
      messages_collected: 1,
      pages_collected: 1,
      version: 1,
    };
    const { repository, query } = repositoryWithClient([
      result([]),
      result([]),
      result([{ count: 1 }]),
      result([completedRow]),
      result([]),
    ]);
    const observedAt = new Date('2026-07-18T01:00:00.000Z');
    const retentionExpiresAt = new Date('2026-08-17T01:00:00.000Z');

    await expect(
      repository.savePage({
        collection,
        nextCursor: null,
        observedAt,
        messages: [
          {
            id: 'artifact-1',
            externalId: 'slack:T001:C001:1721178000.000100',
            sourceUri:
              'https://workspace.slack.com/archives/C001/p1721178000000100',
            authorExternalId: 'U001',
            occurredAt: new Date('2024-07-17T01:00:00.000Z'),
            observedAt,
            content: 'Checkout errors began after deployment.',
            contentSha256:
              '019161227621f1e0593af2743068b2068d25eb94d9a5e3142be1611c4cabf53f',
            metadata: {
              collectionType: 'SLACK_THREAD',
              threadTs: collection.threadTs,
            },
            retentionExpiresAt,
          },
        ],
      }),
    ).resolves.toEqual({
      ...collection,
      status: 'COMPLETE',
      messagesCollected: 1,
      pagesCollected: 1,
      version: 1,
    });

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        'ON CONFLICT (\n              tenant_id,\n              incident_id,\n              source_type,\n              external_id\n            ) DO UPDATE',
      ),
      expect.arrayContaining([
        'artifact-1',
        collection.tenantId,
        collection.incidentId,
        'Checkout errors began after deployment.',
      ]),
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('AND version = $8'),
      [
        'COMPLETE',
        null,
        1,
        observedAt,
        observedAt,
        collection.tenantId,
        collection.incidentId,
        0,
        null,
      ],
    );
    expect(query).toHaveBeenNthCalledWith(5, 'COMMIT');
  });

  it('rolls back artifacts when another invocation advances the checkpoint', async () => {
    const { repository, query } = repositoryWithClient([
      result([]),
      result([{ count: 0 }]),
      result([]),
      result([]),
    ]);
    const observedAt = new Date('2026-07-18T01:00:00.000Z');

    await expect(
      repository.savePage({
        collection,
        messages: [],
        nextCursor: 'cursor-2',
        observedAt,
      }),
    ).rejects.toBeInstanceOf(SlackThreadCollectionConcurrencyError);

    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });
});
