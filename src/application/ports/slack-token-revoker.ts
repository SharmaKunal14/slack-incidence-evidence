export type SlackTokenRevocationOutcome = 'REVOKED' | 'ALREADY_REVOKED';

export class SlackTokenRevocationError extends Error {
  public constructor(readonly retryable: boolean) {
    super('Slack token revocation failed');
    this.name = 'SlackTokenRevocationError';
  }
}

export interface SlackTokenRevoker {
  revoke(accessToken: string): Promise<SlackTokenRevocationOutcome>;
}
