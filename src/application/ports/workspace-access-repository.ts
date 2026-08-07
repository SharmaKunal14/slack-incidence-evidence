export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'REVIEWER' | 'VIEWER';

export interface WorkspaceMember {
  readonly cognitoSubject: string;
  readonly slackUserId: string | null;
  readonly role: WorkspaceRole;
  readonly status: 'ACTIVE' | 'REVOKED';
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WorkspaceInvitation {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceDisplayName: string;
  readonly invitedSlackUserId: string;
  readonly deliveryEmail: string;
  readonly role: Exclude<WorkspaceRole, 'OWNER'>;
  readonly status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface ConsumedSlackIdentityAuthorization {
  readonly authorizationId: string;
  readonly invitationId: string;
  readonly cognitoSubject: string;
  readonly tenantId: string;
  readonly invitedSlackUserId: string;
  readonly role: Exclude<WorkspaceRole, 'OWNER'>;
  readonly nonceSha256: string;
  readonly redirectUri: string;
}

export interface WorkspaceAccessRepository {
  listMembers(input: {
    readonly tenantId: string;
    readonly actorSubject: string;
  }): Promise<readonly WorkspaceMember[]>;
  createInvitation(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly actorSubject: string;
    readonly invitedSlackUserId: string;
    readonly deliveryEmail: string;
    readonly role: Exclude<WorkspaceRole, 'OWNER'>;
    readonly tokenSha256: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  }): Promise<WorkspaceInvitation>;
  updateMember(input: {
    readonly tenantId: string;
    readonly actorSubject: string;
    readonly memberSubject: string;
    readonly role: Exclude<WorkspaceRole, 'OWNER'>;
    readonly status: 'ACTIVE' | 'REVOKED';
    readonly updatedAt: Date;
  }): Promise<WorkspaceMember>;
  createIdentityAuthorization(input: {
    readonly id: string;
    readonly tokenSha256: string;
    readonly cognitoSubject: string;
    readonly stateSha256: string;
    readonly browserBindingSha256: string;
    readonly nonceSha256: string;
    readonly redirectUri: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  }): Promise<{ readonly tenantId: string }>;
  consumeIdentityAuthorization(input: {
    readonly stateSha256: string;
    readonly browserBindingSha256: string;
    readonly consumedAt: Date;
  }): Promise<ConsumedSlackIdentityAuthorization | null>;
  completeIdentityAuthorization(input: {
    readonly authorizationId: string;
    readonly invitationId: string;
    readonly cognitoSubject: string;
    readonly teamId: string;
    readonly slackUserId: string;
    readonly role: Exclude<WorkspaceRole, 'OWNER'>;
    readonly completedAt: Date;
  }): Promise<void>;
  failIdentityAuthorization(input: {
    readonly authorizationId: string;
    readonly failureCode: string;
    readonly failedAt: Date;
  }): Promise<void>;
}

export class WorkspaceAccessRepositoryError extends Error {
  public constructor(
    readonly code:
      | 'FORBIDDEN'
      | 'INVITATION_CONFLICT'
      | 'INVITATION_NOT_USABLE'
      | 'IDENTITY_CONFLICT',
  ) {
    super('Workspace access operation failed');
    this.name = 'WorkspaceAccessRepositoryError';
  }
}
