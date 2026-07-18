export interface IncidentReviewReadyNotification {
  readonly workspaceId: string;
  readonly incidentId: string;
  readonly reportDraftId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly timelineEventCount: number;
  readonly claimCount: number;
  readonly openQuestionCount: number;
}

export interface IncidentReviewReadyNotifier {
  notifyReviewReady(
    notification: IncidentReviewReadyNotification,
  ): Promise<void>;
}

export interface IncidentReviewReadyDraft {
  readonly id: string;
  readonly timelineEventCount: number;
  readonly claimCount: number;
  readonly openQuestionCount: number;
}

export interface IncidentReviewReadyDraftReader {
  findReadyDraft(
    tenantId: string,
    incidentId: string,
    reportDraftId: string,
  ): Promise<IncidentReviewReadyDraft | null>;
}
