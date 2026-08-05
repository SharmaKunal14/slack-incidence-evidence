import type { SlackInstallationCredential } from '../onboarding/slack-installation.js';

export class SlackInstallationCredentialStoreError extends Error {
  public constructor(readonly retryable: boolean) {
    super('Slack installation credential could not be stored');
    this.name = 'SlackInstallationCredentialStoreError';
  }
}

export interface SlackInstallationCredentialStore {
  store(input: {
    readonly authorizationId: string;
    readonly credential: SlackInstallationCredential;
  }): Promise<{ readonly secretArn: string }>;
}
