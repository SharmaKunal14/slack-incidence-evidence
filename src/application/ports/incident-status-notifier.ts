export interface IncidentAcceptedNotification {
  readonly workspaceId: string;
  readonly incidentId: string;
  readonly channelId: string;
  readonly threadTs: string;
}

export interface IncidentStatusNotifier {
  notifyAccepted(notification: IncidentAcceptedNotification): Promise<void>;
}
