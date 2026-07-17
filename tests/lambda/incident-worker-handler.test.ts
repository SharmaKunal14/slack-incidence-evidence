import type { SQSEvent, SQSRecord } from 'aws-lambda';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { IncidentWorkflowStarter } from '../../src/application/ports/incident-workflow-starter.js';
import type { IncidentStatusNotifier } from '../../src/application/ports/incident-status-notifier.js';
import type { IncidentReviewJob } from '../../src/domain/incident-review-job.js';
import {
  createIncidentWorkerHandler,
  type IncidentReviewProcessor,
} from '../../src/lambda/incident-worker-handler.js';

const baseJob: IncidentReviewJob = {
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

function createRecord(messageId: string, job: IncidentReviewJob): SQSRecord {
  return {
    messageId,
    receiptHandle: `receipt-${messageId}`,
    body: JSON.stringify(job),
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '1721178000000',
      SenderId: 'sender-1',
      ApproximateFirstReceiveTimestamp: '1721178000000',
    },
    messageAttributes: {},
    md5OfBody: 'md5',
    eventSource: 'aws:sqs',
    eventSourceARN:
      'arn:aws:sqs:ap-southeast-2:123456789012:incident-review-requests.fifo',
    awsRegion: 'ap-southeast-2',
  };
}

function createEvent(...records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

function createLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function createStatusNotifier(): {
  readonly notifier: IncidentStatusNotifier;
  readonly notifyAccepted: ReturnType<typeof vi.fn>;
} {
  const notifyAccepted = vi
    .fn<IncidentStatusNotifier['notifyAccepted']>()
    .mockResolvedValue(undefined);
  return { notifier: { notifyAccepted }, notifyAccepted };
}

describe('createIncidentWorkerHandler', () => {
  it('starts a deterministic workflow for both new and duplicate deliveries', async () => {
    const execute = vi
      .fn<IncidentReviewProcessor['execute']>()
      .mockResolvedValueOnce({ incidentId: 'incident-1', outcome: 'started' })
      .mockResolvedValueOnce({
        incidentId: 'incident-1',
        outcome: 'already_started',
      });
    const start = vi
      .fn<IncidentWorkflowStarter['start']>()
      .mockResolvedValue(undefined);
    const { notifier, notifyAccepted } = createStatusNotifier();
    const handler = createIncidentWorkerHandler({
      processIncidentReview: { execute },
      workflowStarter: { start },
      statusNotifier: notifier,
      logger: createLogger(),
    });

    await expect(
      handler(
        createEvent(
          createRecord('message-1', baseJob),
          createRecord('message-2', baseJob),
        ),
      ),
    ).resolves.toEqual({ batchItemFailures: [] });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenNthCalledWith(1, {
      tenantId: 'T001',
      incidentId: 'incident-1',
      jobId: 'job-1',
    });
    expect(start).toHaveBeenNthCalledWith(2, {
      tenantId: 'T001',
      incidentId: 'incident-1',
      jobId: 'job-1',
    });
    expect(notifyAccepted).toHaveBeenCalledTimes(2);
    expect(notifyAccepted).toHaveBeenNthCalledWith(1, {
      workspaceId: 'T001',
      incidentId: 'incident-1',
      channelId: 'C001',
      threadTs: '1721178000.000100',
    });
  });

  it('retries workflow start after an incident was committed before a failure', async () => {
    const execute = vi
      .fn<IncidentReviewProcessor['execute']>()
      .mockResolvedValueOnce({ incidentId: 'incident-1', outcome: 'started' })
      .mockResolvedValueOnce({
        incidentId: 'incident-1',
        outcome: 'already_started',
      });
    const start = vi
      .fn<IncidentWorkflowStarter['start']>()
      .mockRejectedValueOnce(new Error('Step Functions unavailable'))
      .mockResolvedValueOnce(undefined);
    const { notifier, notifyAccepted } = createStatusNotifier();
    const handler = createIncidentWorkerHandler({
      processIncidentReview: { execute },
      workflowStarter: { start },
      statusNotifier: notifier,
      logger: createLogger(),
    });
    const event = createEvent(createRecord('message-1', baseJob));

    await expect(handler(event)).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'message-1' }],
    });
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
    expect(notifyAccepted).toHaveBeenCalledTimes(1);
  });

  it('retries an idempotent Slack notification after an ambiguous failure', async () => {
    const execute = vi
      .fn<IncidentReviewProcessor['execute']>()
      .mockResolvedValue({
        incidentId: 'incident-1',
        outcome: 'already_started',
      });
    const start = vi
      .fn<IncidentWorkflowStarter['start']>()
      .mockResolvedValue(undefined);
    const notifyAccepted = vi
      .fn<IncidentStatusNotifier['notifyAccepted']>()
      .mockRejectedValueOnce(new Error('Slack response was not observed'))
      .mockResolvedValueOnce(undefined);
    const handler = createIncidentWorkerHandler({
      processIncidentReview: { execute },
      workflowStarter: { start },
      statusNotifier: { notifyAccepted },
      logger: createLogger(),
    });
    const event = createEvent(createRecord('message-1', baseJob));

    await expect(handler(event)).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'message-1' }],
    });
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
    expect(notifyAccepted).toHaveBeenCalledTimes(2);
  });

  it('stops at the first failure and returns it plus all unprocessed records', async () => {
    const firstJob: IncidentReviewJob = { ...baseJob, jobId: 'job-1' };
    const secondJob: IncidentReviewJob = { ...baseJob, jobId: 'job-2' };
    const thirdJob: IncidentReviewJob = { ...baseJob, jobId: 'job-3' };
    const execute = vi
      .fn<IncidentReviewProcessor['execute']>()
      .mockResolvedValueOnce({ incidentId: 'incident-1', outcome: 'started' })
      .mockRejectedValueOnce(new Error('database unavailable'));
    const start = vi
      .fn<IncidentWorkflowStarter['start']>()
      .mockResolvedValue(undefined);
    const { notifier, notifyAccepted } = createStatusNotifier();
    const handler = createIncidentWorkerHandler({
      processIncidentReview: { execute },
      workflowStarter: { start },
      statusNotifier: notifier,
      logger: createLogger(),
    });

    await expect(
      handler(
        createEvent(
          createRecord('message-1', firstJob),
          createRecord('message-2', secondJob),
          createRecord('message-3', thirdJob),
        ),
      ),
    ).resolves.toEqual({
      batchItemFailures: [
        { itemIdentifier: 'message-2' },
        { itemIdentifier: 'message-3' },
      ],
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalledWith(thirdJob);
    expect(start).toHaveBeenCalledTimes(1);
    expect(notifyAccepted).toHaveBeenCalledTimes(1);
  });

  it('rejects a tenant/workspace mismatch before database processing', async () => {
    const mismatchedJob: IncidentReviewJob = {
      ...baseJob,
      tenantId: 'a-different-tenant',
    };
    const execute = vi.fn<IncidentReviewProcessor['execute']>();
    const start = vi.fn<IncidentWorkflowStarter['start']>();
    const { notifier, notifyAccepted } = createStatusNotifier();
    const handler = createIncidentWorkerHandler({
      processIncidentReview: { execute },
      workflowStarter: { start },
      statusNotifier: notifier,
      logger: createLogger(),
    });

    await expect(
      handler(createEvent(createRecord('message-1', mismatchedJob))),
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'message-1' }],
    });

    expect(execute).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(notifyAccepted).not.toHaveBeenCalled();
  });

  it('returns malformed JSON for redelivery instead of throwing the batch', async () => {
    const execute = vi.fn<IncidentReviewProcessor['execute']>();
    const start = vi.fn<IncidentWorkflowStarter['start']>();
    const { notifier, notifyAccepted } = createStatusNotifier();
    const handler = createIncidentWorkerHandler({
      processIncidentReview: { execute },
      workflowStarter: { start },
      statusNotifier: notifier,
      logger: createLogger(),
    });
    const malformed = { ...createRecord('message-1', baseJob), body: '{' };

    await expect(handler(createEvent(malformed))).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'message-1' }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(notifyAccepted).not.toHaveBeenCalled();
  });
});
