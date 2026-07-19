import type { ScheduledEvent } from 'aws-lambda';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createApprovedReportPublicationHandler } from '../../src/lambda/approved-report-publication-handler.js';

const event = {
  version: '0',
  id: '3b4f7d20-64fc-4a0f-88a4-7279bafce801',
  'detail-type': 'Scheduled Event',
  source: 'aws.events',
  account: '123456789012',
  time: '2026-07-19T01:00:00Z',
  region: 'ap-southeast-2',
  resources: [],
  detail: undefined as never,
} satisfies ScheduledEvent<never>;

describe('approved report publication Lambda handler', () => {
  it('uses the scheduled event ID as the bounded database lease owner', async () => {
    const execute = vi.fn().mockResolvedValue({
      claimed: 1,
      completed: 1,
      retryScheduled: 0,
      terminalFailures: 0,
    });
    const handler = createApprovedReportPublicationHandler({
      publications: { execute },
      logger: pino({ level: 'silent' }),
      maxJobs: 1,
      maxAttempts: 8,
      leaseSeconds: 180,
      retryBaseSeconds: 60,
    });

    await expect(handler(event)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith({
      workerId: event.id,
      maxJobs: 1,
      maxAttempts: 8,
      leaseSeconds: 180,
      retryBaseSeconds: 60,
    });
  });
});
