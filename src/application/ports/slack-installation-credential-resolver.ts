export interface RuntimeSlackInstallation {
  readonly workspaceId: string;
  readonly botToken: string;
}

export type SlackInstallationCredentialResolutionErrorCode =
  | 'SLACK_INSTALLATION_LOOKUP_FAILED'
  | 'SLACK_INSTALLATION_NOT_FOUND'
  | 'SLACK_INSTALLATION_NOT_ACTIVE'
  | 'SLACK_INSTALLATION_CREDENTIAL_MISSING'
  | 'SLACK_INSTALLATION_CREDENTIAL_UNAVAILABLE'
  | 'SLACK_INSTALLATION_CREDENTIAL_INVALID'
  | 'SLACK_INSTALLATION_CREDENTIAL_MISMATCH'
  | 'SLACK_INSTALLATION_CREDENTIAL_EXPIRED';

export class SlackInstallationCredentialResolutionError extends Error {
  public constructor(
    public readonly code: SlackInstallationCredentialResolutionErrorCode,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super('Slack installation credential could not be resolved', options);
    this.name = 'SlackInstallationCredentialResolutionError';
  }
}

export interface SlackInstallationCredentialResolver {
  resolve(workspaceId: string): Promise<RuntimeSlackInstallation>;
}
