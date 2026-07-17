import { describe, expect, it, vi, type MockedFunction } from 'vitest';
import { CollectSlackThreadPage } from '../../src/application/collect-slack-thread-page.js';
import type {
  SlackThreadCollection,
  SlackThreadCollectionRepository,
} from '../../src/application/ports/slack-thread-collection-repository.js';
import {
  SlackThreadSourceError,
  type SlackThreadSource,
} from '../../src/application/ports/slack-thread-source.js';

const running: SlackThreadCollection = {
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

function dependencies(): {
  readonly repository: SlackThreadCollectionRepository;
  readonly getOrCreate: MockedFunction<
    SlackThreadCollectionRepository['getOrCreate']
  >;
  readonly savePage: MockedFunction<
    SlackThreadCollectionRepository['savePage']
  >;
  readonly fail: MockedFunction<SlackThreadCollectionRepository['fail']>;
  readonly source: SlackThreadSource;
  readonly fetchPage: MockedFunction<SlackThreadSource['fetchPage']>;
} {
  const getOrCreate = vi
    .fn<SlackThreadCollectionRepository['getOrCreate']>()
    .mockResolvedValue(running);
  const savePage = vi.fn<SlackThreadCollectionRepository['savePage']>();
  const fail = vi.fn<SlackThreadCollectionRepository['fail']>();
  const fetchPage = vi.fn<SlackThreadSource['fetchPage']>();
  return {
    repository: { getOrCreate, savePage, fail },
    getOrCreate,
    savePage,
    fail,
    source: { fetchPage },
    fetchPage,
  };
}

describe('CollectSlackThreadPage', () => {
  it('normalizes and persists one complete page with retention metadata', async () => {
    const dependency = dependencies();
    dependency.fetchPage.mockResolvedValue({
      outcome: 'page',
      messages: [
        {
          messageTs: '1721178000.000100',
          occurredAt: new Date('2024-07-17T01:00:00.000Z'),
          text: 'Checkout errors began after deployment.',
          permalink:
            'https://workspace.slack.com/archives/C001/p1721178000000100',
          authorId: 'U001',
          editedTs: '1721178010.000200',
        },
      ],
      nextCursor: null,
    });
    dependency.savePage.mockImplementation((input) =>
      Promise.resolve({
        ...running,
        status: 'COMPLETE',
        messagesCollected: input.messages.length,
        pagesCollected: 1,
        version: 1,
      }),
    );
    const collector = new CollectSlackThreadPage(
      dependency.repository,
      dependency.source,
      { now: () => new Date('2026-07-18T01:00:00.000Z') },
      { generate: () => 'artifact-1' },
      30,
    );

    await expect(
      collector.execute({
        tenantId: running.tenantId,
        incidentId: running.incidentId,
      }),
    ).resolves.toEqual({
      status: 'COMPLETE',
      messagesCollected: 1,
      pagesCollected: 1,
    });

    const savedPage = dependency.savePage.mock.calls[0]?.[0];
    expect(savedPage).toBeDefined();
    if (savedPage === undefined) {
      throw new Error('Expected one persisted Slack page');
    }
    expect(savedPage.collection).toEqual(running);
    expect(savedPage.nextCursor).toBeNull();
    expect(savedPage.observedAt).toEqual(new Date('2026-07-18T01:00:00.000Z'));
    expect(savedPage.messages).toHaveLength(1);
    expect(savedPage.messages[0]).toEqual({
      id: 'artifact-1',
      externalId: 'slack:T001:C001:1721178000.000100',
      sourceUri: 'https://workspace.slack.com/archives/C001/p1721178000000100',
      authorExternalId: 'U001',
      occurredAt: new Date('2024-07-17T01:00:00.000Z'),
      observedAt: new Date('2026-07-18T01:00:00.000Z'),
      content: 'Checkout errors began after deployment.',
      contentSha256:
        '019161227621f1e0593af2743068b2068d25eb94d9a5e3142be1611c4cabf53f',
      metadata: {
        provider: 'slack',
        collectionType: 'SLACK_THREAD',
        workspaceId: 'T001',
        channelId: 'C001',
        threadTs: '1721178000.000100',
        messageTs: '1721178000.000100',
        editedTs: '1721178010.000200',
        permalinkStatus: 'AVAILABLE',
      },
      retentionExpiresAt: new Date('2026-08-17T01:00:00.000Z'),
    });
  });

  it('does not call Slack again after a durable completion', async () => {
    const dependency = dependencies();
    dependency.getOrCreate.mockResolvedValue({
      ...running,
      status: 'COMPLETE',
      messagesCollected: 12,
      pagesCollected: 1,
    });
    const collector = new CollectSlackThreadPage(
      dependency.repository,
      dependency.source,
      { now: () => new Date() },
      { generate: () => 'unused' },
      30,
    );

    await expect(
      collector.execute({ tenantId: 'T001', incidentId: running.incidentId }),
    ).resolves.toEqual({
      status: 'COMPLETE',
      messagesCollected: 12,
      pagesCollected: 1,
    });
    expect(dependency.fetchPage).not.toHaveBeenCalled();
  });

  it('returns a bounded wait when Slack rate limits the page', async () => {
    const dependency = dependencies();
    dependency.fetchPage.mockResolvedValue({
      outcome: 'rate_limited',
      retryAfterSeconds: 5_000,
    });
    const collector = new CollectSlackThreadPage(
      dependency.repository,
      dependency.source,
      { now: () => new Date() },
      { generate: () => 'unused' },
      30,
    );

    await expect(
      collector.execute({ tenantId: 'T001', incidentId: running.incidentId }),
    ).resolves.toEqual({
      status: 'RATE_LIMITED',
      retryAfterSeconds: 900,
    });
    expect(dependency.savePage).not.toHaveBeenCalled();
  });

  it('durably records a terminal authorization failure', async () => {
    const dependency = dependencies();
    dependency.fetchPage.mockRejectedValue(
      new SlackThreadSourceError('SLACK_MISSING_SCOPE', false),
    );
    dependency.fail.mockResolvedValue({
      ...running,
      status: 'FAILED',
      failureCode: 'SLACK_MISSING_SCOPE',
      version: 1,
    });
    const collector = new CollectSlackThreadPage(
      dependency.repository,
      dependency.source,
      { now: () => new Date('2026-07-18T01:00:00.000Z') },
      { generate: () => 'unused' },
      30,
    );

    await expect(
      collector.execute({ tenantId: 'T001', incidentId: running.incidentId }),
    ).resolves.toEqual({
      status: 'FAILED',
      failureCode: 'SLACK_MISSING_SCOPE',
    });
    expect(dependency.fail).toHaveBeenCalledWith({
      collection: running,
      failureCode: 'SLACK_MISSING_SCOPE',
      failedAt: new Date('2026-07-18T01:00:00.000Z'),
    });
  });

  it('fails before another Slack call when the configured page budget is exhausted', async () => {
    const dependency = dependencies();
    const atLimit = { ...running, pagesCollected: 1, nextCursor: 'cursor-2' };
    dependency.getOrCreate.mockResolvedValue(atLimit);
    dependency.fail.mockResolvedValue({
      ...atLimit,
      status: 'FAILED',
      failureCode: 'SLACK_THREAD_PAGE_LIMIT_EXCEEDED',
      version: 2,
    });
    const collector = new CollectSlackThreadPage(
      dependency.repository,
      dependency.source,
      { now: () => new Date('2026-07-18T01:00:00.000Z') },
      { generate: () => 'unused' },
      30,
      1,
    );

    await expect(
      collector.execute({ tenantId: 'T001', incidentId: running.incidentId }),
    ).resolves.toEqual({
      status: 'FAILED',
      failureCode: 'SLACK_THREAD_PAGE_LIMIT_EXCEEDED',
    });
    expect(dependency.fetchPage).not.toHaveBeenCalled();
  });

  it('fails a non-advancing Slack cursor instead of looping indefinitely', async () => {
    const dependency = dependencies();
    const checkpoint = { ...running, nextCursor: 'cursor-2', version: 1 };
    dependency.getOrCreate.mockResolvedValue(checkpoint);
    dependency.fetchPage.mockResolvedValue({
      outcome: 'page',
      messages: [],
      nextCursor: 'cursor-2',
    });
    dependency.fail.mockResolvedValue({
      ...checkpoint,
      status: 'FAILED',
      failureCode: 'SLACK_CURSOR_DID_NOT_ADVANCE',
      version: 2,
    });
    const collector = new CollectSlackThreadPage(
      dependency.repository,
      dependency.source,
      { now: () => new Date('2026-07-18T01:00:00.000Z') },
      { generate: () => 'unused' },
      30,
    );

    await expect(
      collector.execute({ tenantId: 'T001', incidentId: running.incidentId }),
    ).resolves.toEqual({
      status: 'FAILED',
      failureCode: 'SLACK_CURSOR_DID_NOT_ADVANCE',
    });
    expect(dependency.savePage).not.toHaveBeenCalled();
  });
});
