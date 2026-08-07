export type SlackAppUninstallOutcome = 'UNINSTALLED' | 'ALREADY_UNINSTALLED';

export class SlackAppUninstallError extends Error {
  public constructor(readonly retryable: boolean) {
    super('Slack app uninstall failed');
    this.name = 'SlackAppUninstallError';
  }
}

export interface SlackAppUninstaller {
  uninstall(accessToken: string): Promise<SlackAppUninstallOutcome>;
}
