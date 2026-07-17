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
  it('uses incident-scoped ordering and a bounded deterministic deduplication ID', async () => {
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
      MessageGroupId: `incident-${createHash('sha256')
        .update(['T001', 'C001', '1721178000.000100'].join('\0'), 'utf8')
        .digest('hex')}`,
      MessageDeduplicationId: createHash('sha256')
        .update('T001', 'utf8')
        .update('\0', 'utf8')
        .update('Ev001', 'utf8')
        .digest('hex'),
    });
  });

  it('keeps retries in one group while allowing independent incident threads to run concurrently', async () => {
    const send = vi.fn().mockResolvedValue({});
    const publisher = new SqsIncidentJobPublisher(
      { send } as unknown as SQSClient,
      'https://sqs.example.test/incident-review-requests.fifo',
    );

    await publisher.publish(job);
    await publisher.publish({
      ...job,
      jobId: 'job-2',
      source: { ...job.source, eventId: 'Ev002' },
    });
    await publisher.publish({
      ...job,
      jobId: 'job-3',
      source: {
        ...job.source,
        eventId: 'Ev003',
        messageTs: '1721179000.000200',
      },
    });

    const inputs = send.mock.calls.map(
      ([command]) =>
        (command as { input: { MessageGroupId: string } }).input.MessageGroupId,
    );
    expect(inputs[0]).toBe(inputs[1]);
    expect(inputs[2]).not.toBe(inputs[0]);
  });
});
