import type { IncidentRepository } from './ports/incident-repository.js';
import type {
  IncidentReviewReadyDraftReader,
  IncidentReviewReadyNotifier,
} from './ports/incident-review-ready-notifier.js';

export interface NotifyIncidentReviewReadyCommand {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly reportDraftId: string;
  readonly timelineEventCount: number;
  readonly claimCount: number;
  readonly openQuestionCount: number;
}

/** Sends a content-free status only after a persisted draft is reviewable. */
export class NotifyIncidentReviewReady {
  public constructor(
    private readonly incidents: IncidentRepository,
    private readonly reportDrafts: IncidentReviewReadyDraftReader,
    private readonly notifier: IncidentReviewReadyNotifier,
  ) {}

  public async execute(input: NotifyIncidentReviewReadyCommand): Promise<void> {
    const incident = await this.incidents.findById(
      input.tenantId,
      input.incidentId,
    );
    if (incident === null) {
      throw new IncidentReviewNotificationConfigurationError(
        'Incident was not found',
      );
    }
    if (incident.status !== 'NEEDS_REVIEW') {
      throw new IncidentReviewNotificationConfigurationError(
        'Incident is not ready for review',
      );
    }
    const reportDraft = await this.reportDrafts.findReadyDraft(
      input.tenantId,
      input.incidentId,
      input.reportDraftId,
    );
    if (reportDraft === null) {
      throw new IncidentReviewNotificationConfigurationError(
        'Review-ready report draft was not found',
      );
    }
    const threadTs = incident.sourceThreadTs ?? incident.sourceMessageTs;
    if (threadTs === undefined) {
      throw new IncidentReviewNotificationConfigurationError(
        'Incident has no Slack thread destination',
      );
    }
    await this.notifier.notifyReviewReady({
      workspaceId: incident.sourceWorkspaceId,
      incidentId: incident.id,
      reportDraftId: input.reportDraftId,
      channelId: incident.sourceChannelId,
      threadTs,
      timelineEventCount: reportDraft.timelineEventCount,
      claimCount: reportDraft.claimCount,
      openQuestionCount: reportDraft.openQuestionCount,
    });
  }
}

export class IncidentReviewNotificationConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IncidentReviewNotificationConfigurationError';
  }
}
