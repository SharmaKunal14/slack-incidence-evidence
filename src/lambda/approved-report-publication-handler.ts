import type { ScheduledEvent } from 'aws-lambda';
import type { Logger } from 'pino';
import type { PublishApprovedReports } from '../application/publish-approved-reports.js';

export interface ApprovedReportPublicationHandlerDependencies {
  readonly publications: Pick<PublishApprovedReports, 'execute'>;
  readonly logger: Logger;
  readonly maxJobs: number;
  readonly maxAttempts: number;
  readonly leaseSeconds: number;
  readonly retryBaseSeconds: number;
}

export type ApprovedReportPublicationHandler = (
  event: ScheduledEvent<never>,
) => Promise<void>;

export function createApprovedReportPublicationHandler(
  dependencies: ApprovedReportPublicationHandlerDependencies,
): ApprovedReportPublicationHandler {
  return async (event) => {
    const result = await dependencies.publications.execute({
      workerId: event.id,
      maxJobs: dependencies.maxJobs,
      maxAttempts: dependencies.maxAttempts,
      leaseSeconds: dependencies.leaseSeconds,
      retryBaseSeconds: dependencies.retryBaseSeconds,
    });
    if (result.terminalFailures > 0) {
      dependencies.logger.error(
        {
          claimed: result.claimed,
          completed: result.completed,
          terminalFailures: result.terminalFailures,
        },
        'approved report publication exhausted retries',
      );
      return;
    }
    if (result.claimed > 0) {
      dependencies.logger.info(
        result,
        'approved report publication run completed',
      );
    }
  };
}
