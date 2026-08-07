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

export type WorkspaceInvitationEmailFailureStage =
  'VALIDATION' | 'REQUEST' | 'RESPONSE';

export type WorkspaceInvitationEmailFailureCode =
  | 'INVALID_INPUT'
  | 'REQUEST_ABORTED'
  | 'PROVIDER_REJECTED'
  | 'REQUEST_FAILED'
  | 'INVALID_PROVIDER_RESPONSE';

export interface WorkspaceInvitationEmailFailureDiagnostic {
  readonly stage: WorkspaceInvitationEmailFailureStage;
  readonly code: WorkspaceInvitationEmailFailureCode;
  readonly retryable: boolean;
  readonly providerCode?: string;
  readonly providerRequestId?: string;
  readonly httpStatusCode?: number;
}

export class WorkspaceInvitationEmailError extends Error {
  public constructor(
    readonly diagnostic: WorkspaceInvitationEmailFailureDiagnostic,
  ) {
    super('Workspace invitation email could not be delivered');
    this.name = 'WorkspaceInvitationEmailError';
  }
}
