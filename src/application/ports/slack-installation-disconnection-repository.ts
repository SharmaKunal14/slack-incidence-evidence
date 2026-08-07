export interface SlackInstallationDisconnectClaim {
  readonly installationId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly credentialSecretArn: string | null;
  readonly state: 'CLAIMED' | 'RESUMED' | 'ALREADY_DISCONNECTED';
}

export class SlackInstallationDisconnectionRepositoryError extends Error {
  public constructor(readonly code: 'ADMIN_REQUIRED' | 'CONFLICT') {
    super('Slack installation disconnection persistence failed');
    this.name = 'SlackInstallationDisconnectionRepositoryError';
  }
}

export interface SlackInstallationDisconnectionRepository {
  begin(input: {
    readonly workspaceId: string;
    readonly cognitoSubject: string;
    readonly auditEventId: string;
    readonly requestId: string;
    readonly occurredAt: Date;
  }): Promise<SlackInstallationDisconnectClaim>;

  complete(input: {
    readonly claim: SlackInstallationDisconnectClaim;
    readonly cognitoSubject: string;
    readonly auditEventId: string;
    readonly requestId: string;
    readonly slackRevocationOutcome:
      'REVOKED' | 'ALREADY_REVOKED' | 'CREDENTIAL_UNAVAILABLE';
    readonly secretDeletionScheduled: boolean;
    readonly occurredAt: Date;
  }): Promise<{ readonly idempotent: boolean }>;

  recordFailure(input: {
    readonly claim: SlackInstallationDisconnectClaim;
    readonly cognitoSubject: string;
    readonly auditEventId: string;
    readonly requestId: string;
    readonly failureCode: string;
    readonly retryable: boolean;
    readonly occurredAt: Date;
  }): Promise<void>;
}
