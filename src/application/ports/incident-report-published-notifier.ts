import type { ReportPublicationProvider } from './approved-report-publisher.js';

export interface IncidentReportPublishedNotification {
  readonly workspaceId: string;
  readonly incidentId: string;
  readonly revisionId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly publisher: ReportPublicationProvider;
  readonly reportPageUrl: string;
}

export interface IncidentReportPublishedNotifier {
  notifyReportPublished(
    notification: IncidentReportPublishedNotification,
  ): Promise<{ readonly messageTs: string }>;
}
