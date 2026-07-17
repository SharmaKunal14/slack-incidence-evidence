import { describe, expect, it, vi } from 'vitest';
import { RequestIncidentReview } from '../../src/application/request-incident-review.js';
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
