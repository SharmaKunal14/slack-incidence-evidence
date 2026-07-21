import { describe, expect, it, vi } from 'vitest';
import { CollectSlackSourcePage } from '../../src/application/collect-slack-source-page.js';
import type {
  IncidentSourceCollection,
  IncidentSourceCollectionRepository,
} from '../../src/application/ports/incident-source-collection-repository.js';
import { SlackChannelSourceError } from '../../src/application/ports/slack-channel-source.js';

const now = new Date('2026-07-20T04:00:00Z');
const collection: IncidentSourceCollection = {
  tenantId: 'T001',
  incidentId: '00000000-0000-4000-8000-000000000001',
  sourceId: '00000000-0000-4000-8000-000000000002',
  runId: '00000000-0000-4000-8000-000000000003',
  workspaceId: 'T001',
  channelId: 'C001',
  sourceKind: 'SLACK_CHANNEL',
  displayName: 'incident-checkout',
  requestedStartAt: new Date('2026-07-20T02:00:00Z'),
  requestedEndAt: new Date('2026-07-20T03:00:00Z'),
  anchorThreadTimestamps: [],
  discoveredThreadTimestamps: [],
  status: 'COLLECTING',
  phase: 'CHANNEL',
  anchorIndex: 0,
  cursor: null,
  pagesCollected: 1,
  messagesCollected: 4,
  rateLimitCount: 0,
  transientFailureCount: 0,
  checkpointVersion: 1,
  retentionDays: 30,
};

function repository(
  persistedCollection: IncidentSourceCollection = collection,
): {
  readonly value: IncidentSourceCollectionRepository;
  readonly advance: ReturnType<
    typeof vi.fn<IncidentSourceCollectionRepository['advance']>
  >;
  readonly finish: ReturnType<
    typeof vi.fn<IncidentSourceCollectionRepository['finish']>
  >;
  readonly recordTransientFailure: ReturnType<
    typeof vi.fn<IncidentSourceCollectionRepository['recordTransientFailure']>
  >;
} {
  const finish = vi
    .fn<IncidentSourceCollectionRepository['finish']>()
    .mockImplementation((input) =>
      Promise.resolve({
        ...input.collection,
        status: input.status,
        phase: 'COMPLETE',
      }),
    );
  const recordTransientFailure = vi
    .fn<IncidentSourceCollectionRepository['recordTransientFailure']>()
    .mockResolvedValue({
      ...persistedCollection,
      transientFailureCount: 1,
      checkpointVersion: persistedCollection.checkpointVersion + 1,
    });
  const advance = vi
    .fn<IncidentSourceCollectionRepository['advance']>()
    .mockImplementation((input) =>
      Promise.resolve({
        ...input.collection,
        status: input.completed ? 'COMPLETE' : 'COLLECTING',
        phase: input.nextPhase,
        anchorIndex: input.nextAnchorIndex,
        cursor: input.nextCursor,
        discoveredThreadTimestamps: input.nextDiscoveredThreadTimestamps,
        pagesCollected: input.collection.pagesCollected + 1,
        checkpointVersion: input.collection.checkpointVersion + 1,
      }),
    );
  return {
    advance,
    finish,
    recordTransientFailure,
    value: {
      getOrCreate: vi.fn().mockResolvedValue(persistedCollection),
      advance,
      recordRateLimit: vi.fn().mockResolvedValue(persistedCollection),
      recordTransientFailure,
      finish,
    },
  };
}

describe('CollectSlackSourcePage', () => {
  it('merges bounded discovered threads with explicit anchors and deduplicates them', async () => {
    const anchoredCollection = {
      ...collection,
      anchorThreadTimestamps: ['1721458800.000100'],
    };
    const collections = repository(anchoredCollection);
    const fetchPage = vi.fn().mockResolvedValue({
      outcome: 'page',
      messages: [],
      threadRootTimestamps: [
        '1721458800.000100',
        '1721458860.000200',
        '1721458860.000200',
      ],
      nextCursor: null,
    });
    const useCase = new CollectSlackSourcePage(
      collections.value,
      { fetchPage },
      { now: () => now },
      { generate: () => '00000000-0000-4000-8000-000000000004' },
      100,
      10,
    );

    await expect(
      useCase.execute({
        tenantId: collection.tenantId,
        incidentId: collection.incidentId,
        sourceId: collection.sourceId,
      }),
    ).resolves.toMatchObject({ status: 'CONTINUE' });
    expect(collections.advance).toHaveBeenCalledWith(
      expect.objectContaining({
        nextPhase: 'ANCHOR_THREAD',
        nextAnchorIndex: 0,
        nextDiscoveredThreadTimestamps: ['1721458860.000200'],
      }),
    );
  });

  it('resumes expansion of a discovered thread after explicit anchors', async () => {
    const expandingCollection: IncidentSourceCollection = {
      ...collection,
      anchorThreadTimestamps: ['1721458800.000100'],
      discoveredThreadTimestamps: ['1721458860.000200'],
      phase: 'ANCHOR_THREAD',
      anchorIndex: 1,
      cursor: null,
    };
    const collections = repository(expandingCollection);
    const fetchPage = vi.fn().mockResolvedValue({
      outcome: 'page',
      messages: [],
      threadRootTimestamps: [],
      nextCursor: null,
    });
    const useCase = new CollectSlackSourcePage(
      collections.value,
      { fetchPage },
      { now: () => now },
      { generate: () => '00000000-0000-4000-8000-000000000004' },
    );

    await expect(
      useCase.execute({
        tenantId: collection.tenantId,
        incidentId: collection.incidentId,
        sourceId: collection.sourceId,
      }),
    ).resolves.toMatchObject({ status: 'COMPLETE' });
    expect(fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'ANCHOR_THREAD',
        threadTs: '1721458860.000200',
      }),
    );
    expect(collections.advance).toHaveBeenCalledWith(
      expect.objectContaining({
        completed: true,
        nextPhase: 'COMPLETE',
        nextAnchorIndex: 2,
      }),
    );
  });

  it('checkpoints newly discovered roots across channel-history pages', async () => {
    const pagedCollection: IncidentSourceCollection = {
      ...collection,
      discoveredThreadTimestamps: ['1721458800.000100'],
      cursor: 'history-page-2',
    };
    const collections = repository(pagedCollection);
    const useCase = new CollectSlackSourcePage(
      collections.value,
      {
        fetchPage: vi.fn().mockResolvedValue({
          outcome: 'page',
          messages: [],
          threadRootTimestamps: ['1721458800.000100', '1721458860.000200'],
          nextCursor: 'history-page-3',
        }),
      },
      { now: () => now },
      { generate: () => '00000000-0000-4000-8000-000000000004' },
    );

    await expect(
      useCase.execute({
        tenantId: collection.tenantId,
        incidentId: collection.incidentId,
        sourceId: collection.sourceId,
      }),
    ).resolves.toMatchObject({ status: 'CONTINUE' });
    expect(collections.advance).toHaveBeenCalledWith(
      expect.objectContaining({
        nextPhase: 'CHANNEL',
        nextCursor: 'history-page-3',
        nextDiscoveredThreadTimestamps: [
          '1721458800.000100',
          '1721458860.000200',
        ],
      }),
    );
  });

  it('fails explicitly rather than silently truncating automatic thread discovery', async () => {
    const collections = repository();
    const useCase = new CollectSlackSourcePage(
      collections.value,
      {
        fetchPage: vi.fn().mockResolvedValue({
          outcome: 'page',
          messages: [],
          threadRootTimestamps: ['1721458800.000100', '1721458860.000200'],
          nextCursor: null,
        }),
      },
      { now: () => now },
      { generate: () => '00000000-0000-4000-8000-000000000004' },
      100,
      1,
    );

    await expect(
      useCase.execute({
        tenantId: collection.tenantId,
        incidentId: collection.incidentId,
        sourceId: collection.sourceId,
      }),
    ).resolves.toMatchObject({
      status: 'COMPLETE',
      sourceStatus: 'PARTIAL',
    });
    expect(collections.advance).not.toHaveBeenCalled();
    expect(collections.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'SLACK_DISCOVERED_THREAD_LIMIT_EXCEEDED',
      }),
    );
  });

  it('records inaccessible late failures as partial and keeps the incident pipeline moving', async () => {
    const collections = repository();
    const useCase = new CollectSlackSourcePage(
      collections.value,
      {
        fetchPage: vi
          .fn()
          .mockRejectedValue(
            new SlackChannelSourceError(
              'SLACK_NO_PERMISSION',
              false,
              'INACCESSIBLE',
            ),
          ),
      },
      { now: () => now },
      { generate: () => '00000000-0000-4000-8000-000000000004' },
    );

    await expect(
      useCase.execute({
        tenantId: collection.tenantId,
        incidentId: collection.incidentId,
        sourceId: collection.sourceId,
      }),
    ).resolves.toMatchObject({
      status: 'COMPLETE',
      sourceStatus: 'PARTIAL',
      messagesCollected: 4,
    });
    expect(collections.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        permissionOutcome: 'DENIED',
        reason: 'SLACK_NO_PERMISSION',
      }),
    );
  });

  it('checkpoints transient failures and delegates bounded exponential waiting', async () => {
    const collections = repository();
    const useCase = new CollectSlackSourcePage(
      collections.value,
      {
        fetchPage: vi
          .fn()
          .mockRejectedValue(
            new SlackChannelSourceError('SLACK_NETWORK_ERROR', true),
          ),
      },
      { now: () => now },
      { generate: () => '00000000-0000-4000-8000-000000000004' },
    );

    await expect(
      useCase.execute({
        tenantId: collection.tenantId,
        incidentId: collection.incidentId,
        sourceId: collection.sourceId,
      }),
    ).resolves.toEqual({
      status: 'RATE_LIMITED',
      sourceId: collection.sourceId,
      retryAfterSeconds: 2,
    });
    expect(collections.recordTransientFailure).toHaveBeenCalledWith(
      collection,
      'SLACK_NETWORK_ERROR',
      2,
      now,
    );
  });
});
