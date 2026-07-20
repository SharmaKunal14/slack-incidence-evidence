import { describe, expect, it, vi } from 'vitest';
import {
  RequestIncidentReview,
  RequestScopedIncidentReview,
} from '../../src/application/request-incident-review.js';
import type { IncidentJobPublisher } from '../../src/application/ports/incident-job-publisher.js';

describe('RequestIncidentReview', () => {
  it('publishes a versioned job without copying Slack message content', async () => {
    const publish = vi
      .fn<IncidentJobPublisher['publish']>()
      .mockResolvedValue();
    const useCase = new RequestIncidentReview(
      { publish },
      { now: () => new Date('2026-07-17T01:00:00.000Z') },
      { generate: () => 'job-1' },
    );

    await expect(
      useCase.execute({
        eventId: 'Ev001',
        workspaceId: 'T001',
        channelId: 'C001',
        messageTs: '1721178000.000100',
        userId: 'U001',
        requestedTitle: 'Checkout outage',
      }),
    ).resolves.toBe('job-1');

    expect(publish).toHaveBeenCalledWith({
      type: 'incident.review.requested',
      version: 1,
      jobId: 'job-1',
      tenantId: 'T001',
      requestedAt: '2026-07-17T01:00:00.000Z',
      requestedTitle: 'Checkout outage',
      source: {
        provider: 'slack',
        eventId: 'Ev001',
        workspaceId: 'T001',
        channelId: 'C001',
        messageTs: '1721178000.000100',
        userId: 'U001',
      },
    });
  });
});

describe('RequestScopedIncidentReview', () => {
  it('publishes a bounded version-two scope without Slack message content', async () => {
    const publish = vi
      .fn<IncidentJobPublisher['publish']>()
      .mockResolvedValue();
    const useCase = new RequestScopedIncidentReview(
      { publish },
      { now: () => new Date('2026-07-20T04:00:00.000Z') },
      { generate: () => 'job-2' },
    );

    await useCase.execute({
      eventId: 'slack-view:V001',
      workspaceId: 'T001',
      channelId: 'C001',
      messageTs: '1721178000.000100',
      userId: 'U001',
      requestedTitle: 'Checkout outage',
      startedAt: '2026-07-20T02:00:00.000Z',
      endedAt: '2026-07-20T03:00:00.000Z',
      reviewerUserId: 'U002',
      evidenceRetentionDays: 30,
      channels: [
        { channelId: 'C001', role: 'PRIMARY', anchorThreadTs: [] },
        {
          channelId: 'C002',
          role: 'ADDITIONAL',
          anchorThreadTs: ['1721178000.000200'],
        },
      ],
    });

    const published = publish.mock.calls[0]?.[0];
    expect(published?.version).toBe(2);
    if (published?.version !== 2) {
      throw new Error('Expected a version-two scoped incident job');
    }
    expect(published.scope.reviewerUserId).toBe('U002');
    expect(published.scope.evidenceRetentionDays).toBe(30);
    expect(published.scope.channels[1]?.channelId).toBe('C002');
    expect(JSON.stringify(published)).not.toContain('message content');
  });
});
