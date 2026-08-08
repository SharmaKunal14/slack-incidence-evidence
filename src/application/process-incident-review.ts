import type { Clock } from './ports/clock.js';
import type { IdGenerator } from './ports/id-generator.js';
import {
  OptimisticConcurrencyError,
  type IncidentRepository,
} from './ports/incident-repository.js';
import { IncidentAggregate } from '../domain/incident.js';
import type { IncidentReviewJob } from '../domain/incident-review-job.js';
import type { CreateIncidentSource } from '../domain/incident-source.js';

export interface ProcessIncidentReviewResult {
  readonly incidentId: string;
  readonly outcome: 'started' | 'already_started';
  readonly sourceIds?: readonly string[];
}

/**
 * Starts the durable incident workflow. Queue delivery is at-least-once; the
 * unique source event plus optimistic versioning makes this operation idempotent.
 */
export class ProcessIncidentReview {
  public constructor(
    private readonly incidents: IncidentRepository,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  public async execute(
    job: IncidentReviewJob,
  ): Promise<ProcessIncidentReviewResult> {
    const incidentId = this.idGenerator.generate();
    const discovered = IncidentAggregate.create({
      id: incidentId,
      tenantId: job.tenantId,
      sourceEventId: job.source.eventId,
      sourceWorkspaceId: job.source.workspaceId,
      sourceChannelId: job.source.channelId,
      sourceMessageTs: job.source.messageTs,
      ...(job.source.threadTs === undefined
        ? {}
        : { sourceThreadTs: job.source.threadTs }),
      requestedByUserId: job.source.userId,
      ...(job.version === 1
        ? {}
        : {
            ...(job.scope.reviewerUserId === undefined
              ? {}
              : { reviewerUserId: job.scope.reviewerUserId }),
            evidenceRetentionDays: job.scope.evidenceRetentionDays,
            startedAt: new Date(job.scope.startedAt),
            resolvedAt: new Date(job.scope.endedAt),
          }),
      title: job.requestedTitle,
      now: new Date(job.requestedAt),
    }).toSnapshot();
    const scope = incidentScope(job, this.idGenerator);

    const result = await this.incidents.createIfAbsent(discovered, scope);
    if (result.incident.status !== 'DISCOVERED') {
      return {
        incidentId: result.incident.id,
        outcome: 'already_started',
        sourceIds: result.sourceIds ?? scope.map((source) => source.id),
      };
    }

    const collecting = IncidentAggregate.rehydrate(result.incident)
      .transitionTo('COLLECTING', this.clock.now())
      .toSnapshot();

    try {
      await this.incidents.save(collecting, result.incident.version);
      return {
        incidentId: collecting.id,
        outcome: result.created ? 'started' : 'already_started',
        sourceIds: result.sourceIds ?? scope.map((source) => source.id),
      };
    } catch (error) {
      // A duplicate delivery can race between createIfAbsent and save. The winner
      // advanced the workflow, so the loser is safe to acknowledge.
      if (!result.created && error instanceof OptimisticConcurrencyError) {
        return {
          incidentId: result.incident.id,
          outcome: 'already_started',
          sourceIds: result.sourceIds ?? scope.map((source) => source.id),
        };
      }
      throw error;
    }
  }
}

function incidentScope(
  job: IncidentReviewJob,
  idGenerator: IdGenerator,
): readonly CreateIncidentSource[] {
  if (job.version === 2) {
    return job.scope.channels.map((channel) => ({
      id: idGenerator.generate(),
      provider: 'SLACK',
      sourceKind: 'SLACK_CHANNEL',
      sourceRole: channel.role,
      providerSourceId: channel.channelId,
      idempotencyIdentity: [
        'slack',
        job.source.workspaceId,
        channel.channelId,
        'channel',
      ].join(':'),
      requestedStartAt: new Date(job.scope.startedAt),
      requestedEndAt: new Date(job.scope.endedAt),
      anchorThreadTimestamps: channel.anchorThreadTs,
    }));
  }

  const requestedAt = new Date(job.requestedAt);
  const messageAt = slackTimestampToDate(
    job.source.threadTs ?? job.source.messageTs,
  );
  return [
    {
      id: idGenerator.generate(),
      provider: 'SLACK',
      sourceKind: 'SLACK_THREAD',
      sourceRole: 'PRIMARY',
      providerSourceId: job.source.channelId,
      idempotencyIdentity: [
        'slack',
        job.source.workspaceId,
        job.source.channelId,
        'thread',
        job.source.threadTs ?? job.source.messageTs,
      ].join(':'),
      requestedStartAt: messageAt,
      requestedEndAt:
        requestedAt.getTime() > messageAt.getTime()
          ? requestedAt
          : new Date(messageAt.getTime() + 1_000),
      anchorThreadTimestamps: [job.source.threadTs ?? job.source.messageTs],
    },
  ];
}

function slackTimestampToDate(value: string): Date {
  const [secondsText, fractionText = '0'] = value.split('.');
  const seconds = Number(secondsText);
  const milliseconds = Number(fractionText.slice(0, 3).padEnd(3, '0'));
  const result = new Date(seconds * 1_000 + milliseconds);
  if (Number.isNaN(result.getTime())) {
    throw new Error('Slack source timestamp is invalid');
  }
  return result;
}
