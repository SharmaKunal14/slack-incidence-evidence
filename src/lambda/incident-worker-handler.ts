import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import type { Logger } from 'pino';
import type { IncidentWorkflowStarter } from '../application/ports/incident-workflow-starter.js';
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
 * execution name. Starting the workflow for both `started` and
 * `already_started` outcomes closes the failure window between committing the
 * incident record and requesting the Step Functions execution.
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
