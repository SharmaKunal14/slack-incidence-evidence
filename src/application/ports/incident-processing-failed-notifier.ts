export interface IncidentProcessingFailedNotification {
  readonly workspaceId: string;
  readonly incidentId: string;
  readonly failureId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly stage: 'ANALYSIS' | 'REPORT';
  readonly failureCode: string;
}

export interface IncidentProcessingFailedNotifier {
  notifyProcessingFailed(
    notification: IncidentProcessingFailedNotification,
  ): Promise<void>;
}
