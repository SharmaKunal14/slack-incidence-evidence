export interface IncidentReportPublishedNotification {
  readonly workspaceId: string;
  readonly incidentId: string;
  readonly revisionId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly notionPageUrl: string;
}

export interface IncidentReportPublishedNotifier {
  notifyReportPublished(
    notification: IncidentReportPublishedNotification,
  ): Promise<{ readonly messageTs: string }>;
}
