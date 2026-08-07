import type { SlackInstallationCredential } from '../onboarding/slack-installation.js';

export class SlackInstallationCredentialLifecycleError extends Error {
  public constructor(readonly retryable: boolean) {
    super('Slack installation credential lifecycle operation failed');
    this.name = 'SlackInstallationCredentialLifecycleError';
  }
}

export interface SlackInstallationCredentialLifecycle {
  load(secretArn: string): Promise<SlackInstallationCredential | null>;
  scheduleDeletion(secretArn: string): Promise<void>;
}
