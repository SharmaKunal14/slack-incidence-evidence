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

function repository(): {
  readonly value: IncidentSourceCollectionRepository;
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
        ...collection,
        status: input.status,
        phase: 'COMPLETE',
      }),
    );
  const recordTransientFailure = vi
    .fn<IncidentSourceCollectionRepository['recordTransientFailure']>()
    .mockResolvedValue({
      ...collection,
      transientFailureCount: 1,
      checkpointVersion: 2,
    });
  return {
    finish,
    recordTransientFailure,
    value: {
      getOrCreate: vi.fn().mockResolvedValue(collection),
      advance: vi.fn(),
      recordRateLimit: vi.fn().mockResolvedValue(collection),
      recordTransientFailure,
      finish,
    },
  };
}

describe('CollectSlackSourcePage', () => {
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
