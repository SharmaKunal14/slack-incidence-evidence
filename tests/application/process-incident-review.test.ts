import { describe, expect, it } from 'vitest';
import { ProcessIncidentReview } from '../../src/application/process-incident-review.js';
import type {
  CreateIncidentResult,
  IncidentRepository,
} from '../../src/application/ports/incident-repository.js';
import type { Incident } from '../../src/domain/incident.js';
import type { IncidentReviewJob } from '../../src/domain/incident-review-job.js';

class InMemoryIncidentRepository implements IncidentRepository {
  private readonly bySourceEvent = new Map<string, Incident>();

  public createIfAbsent(incident: Incident): Promise<CreateIncidentResult> {
    const key = `${incident.tenantId}:${incident.sourceEventId}`;
    const existing = this.bySourceEvent.get(key);
    if (existing !== undefined) {
      return Promise.resolve({ created: false, incident: existing });
    }
    this.bySourceEvent.set(key, incident);
    return Promise.resolve({ created: true, incident });
  }

  public save(incident: Incident, expectedVersion: number): Promise<void> {
    const key = `${incident.tenantId}:${incident.sourceEventId}`;
    const existing = this.bySourceEvent.get(key);
    if (existing?.version !== expectedVersion) {
      return Promise.reject(new Error('concurrency failure'));
    }
    this.bySourceEvent.set(key, incident);
    return Promise.resolve();
  }
}

const job: IncidentReviewJob = {
  type: 'incident.review.requested',
  version: 1,
  jobId: 'job-1',
  tenantId: 'T001',
  requestedAt: '2026-07-17T01:00:00.000Z',
  requestedTitle: 'Checkout outage',
  source: {
    provider: 'slack',
    eventId: 'Ev001',
    workspaceId: 'T001',
    channelId: 'C001',
    messageTs: '1721178000.000100',
    userId: 'U001',
  },
};

describe('ProcessIncidentReview', () => {
  it('starts once and safely accepts a duplicate queue delivery', async () => {
    const repository = new InMemoryIncidentRepository();
    let id = 0;
    const useCase = new ProcessIncidentReview(
      repository,
      { now: () => new Date('2026-07-17T01:01:00.000Z') },
      { generate: () => `incident-${++id}` },
    );

    await expect(useCase.execute(job)).resolves.toEqual({
      incidentId: 'incident-1',
      outcome: 'started',
    });
    await expect(useCase.execute(job)).resolves.toEqual({
      incidentId: 'incident-1',
      outcome: 'already_started',
    });
  });
});
