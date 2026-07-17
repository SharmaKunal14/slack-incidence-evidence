import type { Clock } from './ports/clock.js';
import type { IdGenerator } from './ports/id-generator.js';
import type { IncidentJobPublisher } from './ports/incident-job-publisher.js';
import type { IncidentReviewRequestedV1 } from '../domain/incident-review-job.js';

export interface RequestIncidentReviewCommand {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly threadTs?: string;
  readonly userId: string;
  readonly requestedTitle: string;
}

export class RequestIncidentReview {
  public constructor(
    private readonly publisher: IncidentJobPublisher,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  public async execute(command: RequestIncidentReviewCommand): Promise<string> {
    const jobId = this.idGenerator.generate();
    const job: IncidentReviewRequestedV1 = {
      type: 'incident.review.requested',
      version: 1,
      jobId,
      // The initial deployment is one tenant per Slack workspace. An installation
      // repository will replace this mapping when multi-workspace tenants arrive.
      tenantId: command.workspaceId,
      requestedAt: this.clock.now().toISOString(),
      requestedTitle: command.requestedTitle,
      source: {
        provider: 'slack',
        eventId: command.eventId,
        workspaceId: command.workspaceId,
        channelId: command.channelId,
        messageTs: command.messageTs,
        ...(command.threadTs === undefined
          ? {}
          : { threadTs: command.threadTs }),
        userId: command.userId,
      },
    };

    await this.publisher.publish(job);
    return jobId;
  }
}
