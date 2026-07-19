import type { Clock } from './ports/clock.js';
import type {
  ApprovedReportPublicationJob,
  ApprovedReportPublicationRepository,
} from './ports/approved-report-publication-repository.js';
import {
  ReportPublicationProviderError,
  type ApprovedReportPublisher,
} from './ports/approved-report-publisher.js';
import type { IncidentReportPublishedNotifier } from './ports/incident-report-published-notifier.js';

export interface PublishApprovedReportsResult {
  readonly claimed: number;
  readonly completed: number;
  readonly retryScheduled: number;
  readonly terminalFailures: number;
}

/** Publishes bounded approved revisions with a durable checkpoint per provider. */
export class PublishApprovedReports {
  public constructor(
    private readonly publications: ApprovedReportPublicationRepository,
    private readonly publisher: ApprovedReportPublisher,
    private readonly notifier: IncidentReportPublishedNotifier,
    private readonly clock: Clock,
  ) {}

  public async execute(input: {
    readonly workerId: string;
    readonly maxJobs: number;
    readonly maxAttempts: number;
    readonly leaseSeconds: number;
    readonly retryBaseSeconds: number;
  }): Promise<PublishApprovedReportsResult> {
    validateInput(input);
    let claimed = 0;
    let completed = 0;
    let retryScheduled = 0;
    let terminalFailures = 0;

    for (let index = 0; index < input.maxJobs; index += 1) {
      const claimedAt = this.clock.now();
      const job = await this.publications.claimNext({
        workerId: input.workerId,
        claimedAt,
        leaseExpiresAt: addSeconds(claimedAt, input.leaseSeconds),
        maxAttempts: input.maxAttempts,
        publisher: this.publisher.provider,
      });
      if (job === null) {
        break;
      }
      claimed += 1;

      try {
        if (job.publisher === null) {
          throw new Error('Publication job has no assigned provider');
        }
        const page = await this.ensurePublishedPage(job, input.workerId);
        const slack = await this.notifier.notifyReportPublished({
          workspaceId: job.workspaceId,
          incidentId: job.incidentId,
          revisionId: job.revisionId,
          channelId: job.channelId,
          threadTs: job.threadTs,
          publisher: job.publisher,
          reportPageUrl: page.pageUrl,
        });
        await this.publications.markComplete({
          jobId: job.id,
          workerId: input.workerId,
          slackMessageTs: slack.messageTs,
          completedAt: this.clock.now(),
        });
        completed += 1;
      } catch (error) {
        const failedAt = this.clock.now();
        const terminal = job.attemptCount >= input.maxAttempts;
        const providerRetry =
          error instanceof ReportPublicationProviderError
            ? error.retryAfterSeconds
            : null;
        const retrySeconds = Math.max(
          exponentialRetrySeconds(input.retryBaseSeconds, job.attemptCount),
          providerRetry ?? 0,
        );
        await this.publications.recordFailure({
          jobId: job.id,
          workerId: input.workerId,
          errorCode: safeErrorCode(error),
          retryAt: addSeconds(failedAt, retrySeconds),
          failedAt,
          terminal,
        });
        if (terminal) {
          terminalFailures += 1;
        } else {
          retryScheduled += 1;
        }
      }
    }

    return { claimed, completed, retryScheduled, terminalFailures };
  }

  private async ensurePublishedPage(
    job: ApprovedReportPublicationJob,
    workerId: string,
  ): Promise<{ readonly pageId: string; readonly pageUrl: string }> {
    if (job.publishedPageId !== null && job.publishedPageUrl !== null) {
      if (job.publisher === null) {
        throw new Error('Published page checkpoint has no provider');
      }
      return { pageId: job.publishedPageId, pageUrl: job.publishedPageUrl };
    }
    if (job.publishedPageId !== null || job.publishedPageUrl !== null) {
      throw new Error('Publication job has an incomplete page checkpoint');
    }
    if (job.publisher !== this.publisher.provider) {
      throw new Error('Publication job is assigned to a different provider');
    }
    const page = await this.publisher.publish(job.document);
    await this.publications.markPagePublished({
      jobId: job.id,
      workerId,
      publisher: this.publisher.provider,
      pageId: page.pageId,
      pageUrl: page.pageUrl,
      publishedAt: this.clock.now(),
    });
    return page;
  }
}

function validateInput(input: {
  readonly workerId: string;
  readonly maxJobs: number;
  readonly maxAttempts: number;
  readonly leaseSeconds: number;
  readonly retryBaseSeconds: number;
}): void {
  if (input.workerId.length < 1 || input.workerId.length > 128) {
    throw new Error('Publication worker identifier is invalid');
  }
  for (const [name, value, minimum, maximum] of [
    ['maxJobs', input.maxJobs, 1, 10],
    ['maxAttempts', input.maxAttempts, 1, 20],
    ['leaseSeconds', input.leaseSeconds, 30, 900],
    ['retryBaseSeconds', input.retryBaseSeconds, 30, 3_600],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`Publication ${name} is invalid`);
    }
  }
}

function exponentialRetrySeconds(baseSeconds: number, attempt: number): number {
  return Math.min(baseSeconds * 2 ** Math.max(0, attempt - 1), 3_600);
}

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1_000);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof ReportPublicationProviderError) {
    return /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
      ? error.code
      : 'PUBLICATION_PROVIDER_ERROR';
  }
  return 'UNEXPECTED_PUBLICATION_ERROR';
}
