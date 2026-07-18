import { describe, expect, it, vi } from 'vitest';
import { NotifyIncidentReviewReady } from '../../src/application/notify-incident-review-ready.js';
import type {
  IncidentReviewReadyDraftReader,
  IncidentReviewReadyNotifier,
} from '../../src/application/ports/incident-review-ready-notifier.js';
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
  status: 'NEEDS_REVIEW',
  severity: 'UNCLASSIFIED',
  startedAt: null,
  resolvedAt: null,
  createdAt: new Date('2026-07-18T01:00:00.000Z'),
  updatedAt: new Date('2026-07-18T02:00:00.000Z'),
  version: 7,
};

class Repository implements IncidentRepository {
  public createIfAbsent(value: Incident): Promise<CreateIncidentResult> {
    return Promise.resolve({ created: false, incident: value });
  }

  public findById(
    tenantId: string,
    incidentId: string,
  ): Promise<Incident | null> {
    return Promise.resolve(
      tenantId === incident.tenantId && incidentId === incident.id
        ? incident
        : null,
    );
  }

  public save(): Promise<void> {
    return Promise.resolve();
  }
}

describe('NotifyIncidentReviewReady', () => {
  it('uses the original thread and database-authoritative draft counts', async () => {
    const notifyReviewReady = vi
      .fn<IncidentReviewReadyNotifier['notifyReviewReady']>()
      .mockResolvedValue();
    const findReadyDraft = vi
      .fn<IncidentReviewReadyDraftReader['findReadyDraft']>()
      .mockResolvedValue({
        id: '7df1bcac-5583-4cd6-91db-981989f4c482',
        timelineEventCount: 3,
        claimCount: 2,
        openQuestionCount: 1,
      });
    const useCase = new NotifyIncidentReviewReady(
      new Repository(),
      { findReadyDraft },
      { notifyReviewReady },
    );

    await useCase.execute({
      tenantId: incident.tenantId,
      incidentId: incident.id,
      reportDraftId: '7df1bcac-5583-4cd6-91db-981989f4c482',
      timelineEventCount: 999,
      claimCount: 999,
      openQuestionCount: 999,
    });

    expect(notifyReviewReady).toHaveBeenCalledWith({
      workspaceId: 'T001',
      incidentId: incident.id,
      reportDraftId: '7df1bcac-5583-4cd6-91db-981989f4c482',
      channelId: 'C001',
      threadTs: incident.sourceThreadTs,
      timelineEventCount: 3,
      claimCount: 2,
      openQuestionCount: 1,
    });
    expect(findReadyDraft).toHaveBeenCalledWith(
      incident.tenantId,
      incident.id,
      '7df1bcac-5583-4cd6-91db-981989f4c482',
    );
  });

  it('does not notify when the exact tenant-scoped draft is not reviewable', async () => {
    const notifyReviewReady = vi
      .fn<IncidentReviewReadyNotifier['notifyReviewReady']>()
      .mockResolvedValue();
    const useCase = new NotifyIncidentReviewReady(
      new Repository(),
      { findReadyDraft: vi.fn().mockResolvedValue(null) },
      { notifyReviewReady },
    );

    await expect(
      useCase.execute({
        tenantId: incident.tenantId,
        incidentId: incident.id,
        reportDraftId: '7df1bcac-5583-4cd6-91db-981989f4c482',
        timelineEventCount: 3,
        claimCount: 2,
        openQuestionCount: 1,
      }),
    ).rejects.toThrow('Review-ready report draft was not found');
    expect(notifyReviewReady).not.toHaveBeenCalled();
  });
});
