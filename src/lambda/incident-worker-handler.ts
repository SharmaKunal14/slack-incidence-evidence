import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import type { Logger } from 'pino';
import type { IncidentWorkflowStarter } from '../application/ports/incident-workflow-starter.js';
import type { IncidentStatusNotifier } from '../application/ports/incident-status-notifier.js';
import type { ProcessIncidentReviewResult } from '../application/process-incident-review.js';
import {
  parseIncidentReviewJob,
  type IncidentReviewJob,
} from '../domain/incident-review-job.js';

export interface IncidentReviewProcessor {
  execute(job: IncidentReviewJob): Promise<ProcessIncidentReviewResult>;
}

export interface IncidentWorkerHandlerDependencies {
  readonly processIncidentReview: IncidentReviewProcessor;
  readonly workflowStarter: IncidentWorkflowStarter;
  readonly statusNotifier: IncidentStatusNotifier;
  readonly logger: Logger;
}

export type IncidentWorkerHandler = (
  event: SQSEvent,
) => Promise<SQSBatchResponse>;

/**
 * Adapts Lambda's SQS event source to the incident application workflow.
 *
 * SQS and Lambda provide at-least-once delivery. The application use case owns
 * incident idempotency, while the workflow starter must use a deterministic
 * execution name and the status notifier must use a stable provider idempotency
 * key. Repeating both effects for `started` and `already_started` outcomes
 * closes ambiguous failure windows after the incident commit.
 *
 * For a FIFO queue, processing stops at the first failure. The failed record
 * and every record that has not been attempted are returned so Lambda can retry
 * them without violating message order.
 */
export function createIncidentWorkerHandler(
  dependencies: IncidentWorkerHandlerDependencies,
): IncidentWorkerHandler {
  return async (event) => {
    for (const [index, record] of event.Records.entries()) {
      try {
        const job = parseIncidentReviewJob(JSON.parse(record.body) as unknown);
        const result = await dependencies.processIncidentReview.execute(job);

        await dependencies.workflowStarter.start({
          tenantId: job.tenantId,
          incidentId: result.incidentId,
          jobId: job.jobId,
        });

        await dependencies.statusNotifier.notifyAccepted({
          workspaceId: job.source.workspaceId,
          incidentId: result.incidentId,
          channelId: job.source.channelId,
          threadTs: job.source.threadTs ?? job.source.messageTs,
        });

        dependencies.logger.info(
          {
            messageId: record.messageId,
            jobId: job.jobId,
            incidentId: result.incidentId,
            outcome: result.outcome,
          },
          'incident workflow execution requested',
        );
      } catch (error) {
        dependencies.logger.error(
          { err: error, messageId: record.messageId },
          'incident queue record processing failed',
        );

        return {
          batchItemFailures: event.Records.slice(index).map(
            ({ messageId }) => ({ itemIdentifier: messageId }),
          ),
        };
      }
    }

    return { batchItemFailures: [] };
  };
}
