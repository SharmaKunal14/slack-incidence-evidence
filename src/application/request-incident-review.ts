import type { Clock } from './ports/clock.js';
import type { IdGenerator } from './ports/id-generator.js';
import type { IncidentJobPublisher } from './ports/incident-job-publisher.js';
import type {
  IncidentReviewRequestedV1,
  IncidentReviewRequestedV2,
} from '../domain/incident-review-job.js';

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

export interface RequestScopedIncidentReviewCommand {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly threadTs?: string;
  readonly userId: string;
  readonly requestedTitle: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly reviewerUserId?: string;
  readonly evidenceRetentionDays: number;
  readonly channels: readonly {
    readonly channelId: string;
    readonly role: 'PRIMARY' | 'ADDITIONAL';
    readonly anchorThreadTs: readonly string[];
  }[];
}

export class RequestScopedIncidentReview {
  public constructor(
    private readonly publisher: IncidentJobPublisher,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  public async execute(
    command: RequestScopedIncidentReviewCommand,
  ): Promise<string> {
    const jobId = this.idGenerator.generate();
    const job: IncidentReviewRequestedV2 = {
      type: 'incident.review.requested',
      version: 2,
      jobId,
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
      scope: {
        startedAt: command.startedAt,
        endedAt: command.endedAt,
        ...(command.reviewerUserId === undefined
          ? {}
          : { reviewerUserId: command.reviewerUserId }),
        evidenceRetentionDays: command.evidenceRetentionDays,
        channels: command.channels.map((channel) => ({
          channelId: channel.channelId,
          role: channel.role,
          anchorThreadTs: [...channel.anchorThreadTs],
        })),
      },
    };

    await this.publisher.publish(job);
    return jobId;
  }
}
