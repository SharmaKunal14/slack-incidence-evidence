import type { Clock } from './ports/clock.js';
import type { IdGenerator } from './ports/id-generator.js';
import {
  OptimisticConcurrencyError,
  type IncidentRepository,
} from './ports/incident-repository.js';
import { IncidentAggregate } from '../domain/incident.js';
import type { IncidentReviewJob } from '../domain/incident-review-job.js';

export interface ProcessIncidentReviewResult {
  readonly incidentId: string;
  readonly outcome: 'started' | 'already_started';
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
    const discovered = IncidentAggregate.create({
      id: this.idGenerator.generate(),
      tenantId: job.tenantId,
      sourceEventId: job.source.eventId,
      sourceWorkspaceId: job.source.workspaceId,
      sourceChannelId: job.source.channelId,
      ...(job.source.threadTs === undefined
        ? {}
        : { sourceThreadTs: job.source.threadTs }),
      requestedByUserId: job.source.userId,
      title: job.requestedTitle,
      now: new Date(job.requestedAt),
    }).toSnapshot();

    const result = await this.incidents.createIfAbsent(discovered);
    if (result.incident.status !== 'DISCOVERED') {
      return { incidentId: result.incident.id, outcome: 'already_started' };
    }

    const collecting = IncidentAggregate.rehydrate(result.incident)
      .transitionTo('COLLECTING', this.clock.now())
      .toSnapshot();

    try {
      await this.incidents.save(collecting, result.incident.version);
      return {
        incidentId: collecting.id,
        outcome: result.created ? 'started' : 'already_started',
      };
    } catch (error) {
      // A duplicate delivery can race between createIfAbsent and save. The winner
      // advanced the workflow, so the loser is safe to acknowledge.
      if (!result.created && error instanceof OptimisticConcurrencyError) {
        return { incidentId: result.incident.id, outcome: 'already_started' };
      }
      throw error;
    }
  }
}
