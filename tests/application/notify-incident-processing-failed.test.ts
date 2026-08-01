import { describe, expect, it, vi } from 'vitest';
import { NotifyIncidentProcessingFailed } from '../../src/application/notify-incident-processing-failed.js';
import type { IncidentProcessingFailedNotifier } from '../../src/application/ports/incident-processing-failed-notifier.js';
import type {
  CreateIncidentResult,
  IncidentRepository,
} from '../../src/application/ports/incident-repository.js';
import type { Incident } from '../../src/domain/incident.js';

const incident: Incident = {
  id: '2c6a2f4a-f762-41e9-9620-a07abdaa5c48',
  tenantId: 'T001',
  sourceEventId: 'Ev001',
  sourceWorkspaceId: 'T001',
  sourceChannelId: 'C001',
  sourceMessageTs: '1721178000.000100',
  sourceThreadTs: '1721177999.000001',
  requestedByUserId: 'U001',
  title: 'Checkout outage',
  status: 'FAILED',
  severity: 'UNCLASSIFIED',
  startedAt: null,
  resolvedAt: null,
  createdAt: new Date('2026-07-18T01:00:00.000Z'),
  updatedAt: new Date('2026-07-18T02:00:00.000Z'),
  version: 7,
};

class Repository implements IncidentRepository {
  public constructor(private readonly value: Incident | null = incident) {}

  public createIfAbsent(value: Incident): Promise<CreateIncidentResult> {
    return Promise.resolve({ created: false, incident: value });
  }

  public findById(): Promise<Incident | null> {
    return Promise.resolve(this.value);
  }

  public save(): Promise<void> {
    return Promise.resolve();
  }
}

describe('NotifyIncidentProcessingFailed', () => {
  it('uses the original Slack thread and a content-free failure notification', async () => {
    const notifyProcessingFailed = vi
      .fn<IncidentProcessingFailedNotifier['notifyProcessingFailed']>()
      .mockResolvedValue();
    const useCase = new NotifyIncidentProcessingFailed(new Repository(), {
      notifyProcessingFailed,
    });
    const failureId = '7df1bcac-5583-4cd6-91db-981989f4c482';

    await useCase.execute({
      tenantId: incident.tenantId,
      incidentId: incident.id,
      failureId,
      stage: 'ANALYSIS',
    });

    expect(notifyProcessingFailed).toHaveBeenCalledWith({
      workspaceId: incident.sourceWorkspaceId,
      incidentId: incident.id,
      failureId,
      channelId: incident.sourceChannelId,
      threadTs: incident.sourceThreadTs,
      stage: 'ANALYSIS',
    });
  });

  it('does not send a terminal message for a non-failed incident', async () => {
    const notifyProcessingFailed = vi
      .fn<IncidentProcessingFailedNotifier['notifyProcessingFailed']>()
      .mockResolvedValue();
    const useCase = new NotifyIncidentProcessingFailed(
      new Repository({ ...incident, status: 'EXTRACTING' }),
      { notifyProcessingFailed },
    );

    await expect(
      useCase.execute({
        tenantId: incident.tenantId,
        incidentId: incident.id,
        failureId: '7df1bcac-5583-4cd6-91db-981989f4c482',
        stage: 'ANALYSIS',
      }),
    ).rejects.toThrow('Incident has not reached a terminal failure');
    expect(notifyProcessingFailed).not.toHaveBeenCalled();
  });
});
