export interface SlackOAuthGrant {
  readonly appId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly enterpriseId: string | null;
  readonly botUserId: string;
  readonly authedUserId: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number | null;
  readonly grantedScopes: readonly string[];
  readonly isEnterpriseInstall: boolean;
}

export interface SlackBotIdentity {
  readonly teamId: string;
  readonly userId: string;
}

export class SlackOAuthProviderRequestError extends Error {
  public constructor(readonly retryable: boolean) {
    super('Slack OAuth provider request failed');
    this.name = 'SlackOAuthProviderRequestError';
  }
}

export interface SlackOAuthProvider {
  exchangeCode(input: {
    readonly code: string;
    readonly redirectUri: string;
  }): Promise<SlackOAuthGrant>;
  verifyBot(accessToken: string): Promise<SlackBotIdentity>;
}
