import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { SlackRateLimitError } from '../../src/integrations/slack/web-api-incident-status-notifier.js';
import {
  createIncidentReviewNotificationHandler,
  type IncidentReviewReadyUseCase,
} from '../../src/lambda/incident-review-notification-handler.js';

const event = {
  version: 1 as const,
  tenantId: 'T001',
  incidentId: '2c6a2f4a-f762-41e9-9620-a07abdaa5c48',
  jobId: 'job-1',
  analysisRunId: 'analysis-1',
  reportDraftId: '7df1bcac-5583-4cd6-91db-981989f4c482',
  timelineEventCount: 3,
  claimCount: 2,
  openQuestionCount: 1,
};

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
}

describe('createIncidentReviewNotificationHandler', () => {
  it('preserves bounded workflow identifiers after successful notification', async () => {
    const execute = vi
      .fn<IncidentReviewReadyUseCase['execute']>()
      .mockResolvedValue();
    const handler = createIncidentReviewNotificationHandler({
      notifier: { execute },
      logger: logger(),
    });

    await expect(handler(event)).resolves.toEqual({
      ...event,
      status: 'NOTIFIED',
    });
  });

  it('returns a bounded workflow wait for Slack rate limiting', async () => {
    const execute = vi
      .fn<IncidentReviewReadyUseCase['execute']>()
      .mockRejectedValue(new SlackRateLimitError(45));
    const handler = createIncidentReviewNotificationHandler({
      notifier: { execute },
      logger: logger(),
    });

    await expect(handler(event)).resolves.toEqual({
      ...event,
      status: 'RETRY_WAIT',
      retryAfterSeconds: 45,
    });
  });
});
