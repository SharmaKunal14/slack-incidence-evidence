import type { Logger } from 'pino';
import { z } from 'zod';
import type { NotifyIncidentReviewReadyCommand } from '../application/notify-incident-review-ready.js';
import type { NotifyIncidentProcessingFailedCommand } from '../application/notify-incident-processing-failed.js';
import {
  SlackRateLimitError,
  SlackWebApiError,
} from '../integrations/slack/web-api-incident-status-notifier.js';

const baseWorkflowInputSchema = z
  .object({
    version: z.literal(1),
    tenantId: z.string().regex(/^T[A-Z0-9]{1,63}$/),
    incidentId: z.uuid(),
    jobId: z.string().trim().min(1).max(128),
  })
  .strict();

const reviewReadyWorkflowInputSchema = baseWorkflowInputSchema.extend({
  notificationType: z.literal('REVIEW_READY'),
  analysisRunId: z.string().trim().min(1).max(128),
  reportDraftId: z.uuid(),
  timelineEventCount: z.number().int().nonnegative().max(100_000),
  claimCount: z.number().int().nonnegative().max(100_000),
  openQuestionCount: z.number().int().nonnegative().max(100_000),
});

const processingFailedWorkflowInputSchema = baseWorkflowInputSchema.extend({
  notificationType: z.literal('PROCESSING_FAILED'),
  failureId: z.uuid(),
  failureStage: z.enum(['ANALYSIS', 'REPORT']),
  failureCode: z.string().regex(/^[A-Z0-9_]{1,64}$/),
});

const workflowInputSchema = z.discriminatedUnion('notificationType', [
  reviewReadyWorkflowInputSchema,
  processingFailedWorkflowInputSchema,
]);

export interface IncidentReviewReadyUseCase {
  execute(input: NotifyIncidentReviewReadyCommand): Promise<void>;
}

export interface IncidentProcessingFailedUseCase {
  execute(input: NotifyIncidentProcessingFailedCommand): Promise<void>;
}

export interface IncidentReviewNotificationHandlerDependencies {
  readonly reviewReadyNotifier: IncidentReviewReadyUseCase;
  readonly processingFailedNotifier: IncidentProcessingFailedUseCase;
  readonly logger: Logger;
}

export type IncidentReviewNotificationHandler = (event: unknown) => Promise<
  | (Readonly<z.infer<typeof workflowInputSchema>> & {
      readonly status: 'NOTIFIED';
    })
  | (Readonly<z.infer<typeof workflowInputSchema>> & {
      readonly status: 'RETRY_WAIT';
      readonly retryAfterSeconds: number;
    })
  | (Readonly<z.infer<typeof workflowInputSchema>> & {
      readonly status: 'FAILED';
      readonly failureCode: string;
    })
>;

export function createIncidentReviewNotificationHandler(
  dependencies: IncidentReviewNotificationHandlerDependencies,
): IncidentReviewNotificationHandler {
  return async (event) => {
    const input = workflowInputSchema.parse(event);
    try {
      if (input.notificationType === 'REVIEW_READY') {
        await dependencies.reviewReadyNotifier.execute(input);
      } else {
        await dependencies.processingFailedNotifier.execute({
          tenantId: input.tenantId,
          incidentId: input.incidentId,
          failureId: input.failureId,
          stage: input.failureStage,
        });
      }
      dependencies.logger.info(
        {
          tenantId: input.tenantId,
          incidentId: input.incidentId,
          notificationType: input.notificationType,
          ...(input.notificationType === 'REVIEW_READY'
            ? { reportDraftId: input.reportDraftId }
            : {
                failureId: input.failureId,
                failureStage: input.failureStage,
                failureCode: input.failureCode,
              }),
          notificationStatus: 'NOTIFIED',
        },
        'Incident review-ready notification processed',
      );
      return { ...input, status: 'NOTIFIED' };
    } catch (error) {
      if (error instanceof SlackRateLimitError) {
        return {
          ...input,
          status: 'RETRY_WAIT',
          retryAfterSeconds: boundWait(error.retryAfterSeconds ?? 30),
        };
      }
      if (
        error instanceof SlackWebApiError &&
        !['SLACK_NETWORK_ERROR', 'SLACK_HTTP_ERROR'].includes(error.code)
      ) {
        dependencies.logger.warn(
          {
            tenantId: input.tenantId,
            incidentId: input.incidentId,
            notificationType: input.notificationType,
            ...(input.notificationType === 'REVIEW_READY'
              ? { reportDraftId: input.reportDraftId }
              : {
                  failureId: input.failureId,
                  failureStage: input.failureStage,
                  failureCode: input.failureCode,
                }),
            notificationStatus: 'FAILED',
            failureCode: error.code,
          },
          'Incident draft persisted but Slack notification was not delivered',
        );
        return { ...input, status: 'FAILED', failureCode: error.code };
      }
      throw error;
    }
  };
}

function boundWait(seconds: number): number {
  return Math.min(900, Math.max(1, Math.ceil(seconds)));
}
