import { describe, expect, it } from 'vitest';
import {
  IncidentAggregate,
  InvalidIncidentTransitionError,
} from '../../src/domain/incident.js';

const discovered = (): IncidentAggregate =>
  IncidentAggregate.create({
    id: 'incident-1',
    tenantId: 'T001',
    sourceEventId: 'Ev001',
    sourceWorkspaceId: 'T001',
    sourceChannelId: 'C001',
    sourceMessageTs: '1721178000.000100',
    requestedByUserId: 'U001',
    title: 'Checkout outage',
    now: new Date('2026-07-17T01:00:00.000Z'),
  });

describe('IncidentAggregate', () => {
  it('creates a discovered, unclassified incident', () => {
    expect(discovered().toSnapshot()).toMatchObject({
      status: 'DISCOVERED',
      severity: 'UNCLASSIFIED',
      version: 0,
      title: 'Checkout outage',
    });
  });

  it('advances through an allowed transition and increments the version', () => {
    const collecting = discovered().transitionTo(
      'COLLECTING',
      new Date('2026-07-17T01:01:00.000Z'),
    );

    expect(collecting.toSnapshot()).toMatchObject({
      status: 'COLLECTING',
      version: 1,
      updatedAt: new Date('2026-07-17T01:01:00.000Z'),
    });
  });

  it('rejects lifecycle transitions that skip required work', () => {
    expect(() =>
      discovered().transitionTo(
        'PUBLISHED',
        new Date('2026-07-17T01:01:00.000Z'),
      ),
    ).toThrow(InvalidIncidentTransitionError);
  });
});
