export interface SlackIdentity {
  readonly teamId: string;
  readonly userId: string;
}

export interface SlackIdentityProvider {
  exchangeCode(input: {
    readonly code: string;
    readonly redirectUri: string;
    readonly expectedNonceSha256: string;
  }): Promise<SlackIdentity>;
}

export class SlackIdentityProviderError extends Error {
  public constructor(readonly retryable: boolean) {
    super('Slack identity verification failed');
    this.name = 'SlackIdentityProviderError';
  }
}
