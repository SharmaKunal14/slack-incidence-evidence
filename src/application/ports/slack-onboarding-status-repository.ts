export const slackConnectionStatuses = [
  'NOT_CONNECTED',
  'CONNECTING',
  'CONNECTED',
  'RECONNECT_REQUIRED',
  'DISCONNECTING',
  'DISCONNECTED',
  'FAILED',
] as const;

export type SlackConnectionStatus = (typeof slackConnectionStatuses)[number];

export interface SlackOnboardingWorkspaceStatus {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly role: 'OWNER' | 'ADMIN' | 'REVIEWER' | 'VIEWER';
  readonly connectionStatus: SlackConnectionStatus;
  readonly canManage: boolean;
  readonly installedAt: Date | null;
  readonly updatedAt: Date;
  readonly credentialExpiresAt: Date | null;
}

export interface SlackOnboardingStatus {
  readonly canStartInstallation: boolean;
  readonly workspaces: readonly SlackOnboardingWorkspaceStatus[];
}

export interface SlackOnboardingStatusRepository {
  findByCognitoSubject(cognitoSubject: string): Promise<SlackOnboardingStatus>;
}
