import { createHash } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { describe, expect, it, vi } from 'vitest';
import type { IncidentReviewJob } from '../../../src/domain/incident-review-job.js';
import { SqsIncidentJobPublisher } from '../../../src/infrastructure/queue/sqs-incident-job-publisher.js';

const job: IncidentReviewJob = {
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
};

describe('SqsIncidentJobPublisher', () => {
  it('uses tenant ordering and a bounded deterministic deduplication ID', async () => {
    const send = vi.fn().mockResolvedValue({});
    const publisher = new SqsIncidentJobPublisher(
      { send } as unknown as SQSClient,
      'https://sqs.example.test/incident-review-requests.fifo',
    );

    await publisher.publish(job);

    const command = send.mock.calls[0]?.[0] as
      { input?: Record<string, unknown> } | undefined;
    expect(command?.input).toMatchObject({
      QueueUrl: 'https://sqs.example.test/incident-review-requests.fifo',
      MessageGroupId: 'T001',
      MessageDeduplicationId: createHash('sha256')
        .update('T001:Ev001', 'utf8')
        .digest('hex'),
    });
  });
});
