import type { WorkspaceRole } from './workspace-access-repository.js';

export interface WorkspaceInvitationEmailSender {
  send(input: {
    readonly recipientEmail: string;
    readonly invitationUrl: string;
    readonly workspaceDisplayName: string;
    readonly role: Exclude<WorkspaceRole, 'OWNER'>;
    readonly expiresAt: Date;
  }): Promise<{ readonly providerMessageId: string }>;
}

export class WorkspaceInvitationEmailError extends Error {
  public constructor(readonly retryable: boolean) {
    super('Workspace invitation email could not be delivered');
    this.name = 'WorkspaceInvitationEmailError';
  }
}
