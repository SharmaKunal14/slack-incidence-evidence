import type { Pool, PoolClient } from 'pg';
import {
  WorkspaceAccessRepositoryError,
  type ConsumedSlackIdentityAuthorization,
  type WorkspaceAccessRepository,
  type WorkspaceInvitation,
  type WorkspaceMember,
} from '../../application/ports/workspace-access-repository.js';

interface DatabaseError extends Error {
  readonly code?: string;
}

export class PostgresWorkspaceAccessRepository implements WorkspaceAccessRepository {
  public constructor(private readonly pool: Pool) {}

  public async listMembers(input: {
    readonly tenantId: string;
    readonly actorSubject: string;
  }): Promise<readonly WorkspaceMember[]> {
    const result = await this.pool.query<{
      cognito_subject: string;
      slack_user_id: string | null;
      role: WorkspaceMember['role'];
      status: WorkspaceMember['status'];
      created_at: Date;
      updated_at: Date;
    }>(
      `
      SELECT member.cognito_subject, member.slack_user_id, member.role,
             member.status, member.created_at, member.updated_at
      FROM reviewer_memberships actor
      JOIN reviewer_memberships member ON member.tenant_id = actor.tenant_id
      WHERE actor.tenant_id = $1 AND actor.cognito_subject = $2
        AND actor.status = 'ACTIVE' AND actor.role IN ('OWNER', 'ADMIN')
      ORDER BY member.status, member.role, member.created_at, member.cognito_subject
    `,
      [input.tenantId, input.actorSubject],
    );
    if (result.rows.length === 0)
      throw new WorkspaceAccessRepositoryError('FORBIDDEN');
    return result.rows.map((row) => ({
      cognitoSubject: row.cognito_subject,
      slackUserId: row.slack_user_id,
      role: row.role,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public async createInvitation(
    input: Parameters<WorkspaceAccessRepository['createInvitation']>[0],
  ): Promise<WorkspaceInvitation> {
    try {
      const result = await this.pool.query<{
        id: string;
        tenant_id: string;
        workspace_display_name: string;
        invited_slack_user_id: string;
        delivery_email: string;
        role: WorkspaceInvitation['role'];
        status: WorkspaceInvitation['status'];
        expires_at: Date;
        created_at: Date;
      }>(
        `
        WITH inserted AS (
          INSERT INTO workspace_invitations (
            id, tenant_id, invited_slack_user_id, delivery_email, role,
            token_sha256, status, invited_by_subject, created_at, expires_at, updated_at
          )
          SELECT $1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9, $8
          FROM reviewer_memberships actor
          WHERE actor.tenant_id = $2 AND actor.cognito_subject = $7
            AND actor.status = 'ACTIVE' AND actor.role IN ('OWNER', 'ADMIN')
            AND NOT EXISTS (
              SELECT 1 FROM reviewer_memberships existing
              WHERE existing.tenant_id = $2 AND existing.slack_user_id = $3
                AND existing.status = 'ACTIVE'
            )
          RETURNING id, tenant_id, invited_slack_user_id, delivery_email, role,
                    status, expires_at, created_at
        )
        SELECT inserted.*, tenant.display_name AS workspace_display_name
        FROM inserted
        JOIN tenants tenant ON tenant.id = inserted.tenant_id
      `,
        [
          input.id,
          input.tenantId,
          input.invitedSlackUserId,
          input.deliveryEmail,
          input.role,
          input.tokenSha256,
          input.actorSubject,
          input.createdAt,
          input.expiresAt,
        ],
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new WorkspaceAccessRepositoryError('FORBIDDEN');
      return {
        id: row.id,
        tenantId: row.tenant_id,
        workspaceDisplayName: row.workspace_display_name,
        invitedSlackUserId: row.invited_slack_user_id,
        deliveryEmail: row.delivery_email,
        role: row.role,
        status: row.status,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      };
    } catch (error) {
      if (error instanceof WorkspaceAccessRepositoryError) throw error;
      if ((error as DatabaseError).code === '23505')
        throw new WorkspaceAccessRepositoryError('INVITATION_CONFLICT');
      throw error;
    }
  }

  public async updateMember(
    input: Parameters<WorkspaceAccessRepository['updateMember']>[0],
  ): Promise<WorkspaceMember> {
    const result = await this.pool.query<{
      cognito_subject: string;
      slack_user_id: string | null;
      role: WorkspaceMember['role'];
      status: WorkspaceMember['status'];
      created_at: Date;
      updated_at: Date;
    }>(
      `
      UPDATE reviewer_memberships target
      SET role = $4, status = $5, updated_at = $6,
          revoked_at = CASE WHEN $5 = 'REVOKED' THEN $6 ELSE NULL END
      FROM reviewer_memberships actor
      WHERE target.tenant_id = $1 AND target.cognito_subject = $3
        AND target.role <> 'OWNER'
        AND actor.tenant_id = target.tenant_id AND actor.cognito_subject = $2
        AND actor.status = 'ACTIVE' AND actor.role IN ('OWNER', 'ADMIN')
      RETURNING target.cognito_subject, target.slack_user_id, target.role,
                target.status, target.created_at, target.updated_at
    `,
      [
        input.tenantId,
        input.actorSubject,
        input.memberSubject,
        input.role,
        input.status,
        input.updatedAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new WorkspaceAccessRepositoryError('FORBIDDEN');
    return {
      cognitoSubject: row.cognito_subject,
      slackUserId: row.slack_user_id,
      role: row.role,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  public async createIdentityAuthorization(
    input: Parameters<
      WorkspaceAccessRepository['createIdentityAuthorization']
    >[0],
  ): Promise<{ readonly tenantId: string }> {
    const result = await this.pool.query<{ tenant_id: string }>(
      `
      INSERT INTO slack_identity_authorizations (
        id, invitation_id, cognito_subject, state_sha256,
        browser_binding_sha256, nonce_sha256, redirect_uri,
        status, created_at, expires_at
      )
      SELECT $1, invitation.id, $3, $4, $5, $6, $7, 'PENDING', $8, $9
      FROM workspace_invitations invitation
      WHERE invitation.token_sha256 = $2 AND invitation.status = 'PENDING'
        AND invitation.expires_at > $8
      RETURNING (SELECT tenant_id FROM workspace_invitations WHERE id = invitation_id) AS tenant_id
    `,
      [
        input.id,
        input.tokenSha256,
        input.cognitoSubject,
        input.stateSha256,
        input.browserBindingSha256,
        input.nonceSha256,
        input.redirectUri,
        input.createdAt,
        input.expiresAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new WorkspaceAccessRepositoryError('INVITATION_NOT_USABLE');
    return { tenantId: row.tenant_id };
  }

  public async consumeIdentityAuthorization(
    input: Parameters<
      WorkspaceAccessRepository['consumeIdentityAuthorization']
    >[0],
  ): Promise<ConsumedSlackIdentityAuthorization | null> {
    const result = await this.pool.query<{
      authorization_id: string;
      invitation_id: string;
      cognito_subject: string;
      tenant_id: string;
      invited_slack_user_id: string;
      role: ConsumedSlackIdentityAuthorization['role'];
      nonce_sha256: string;
      redirect_uri: string;
    }>(
      `
      UPDATE slack_identity_authorizations AS identity_auth
      SET status = 'CONSUMED', consumed_at = $3
      FROM workspace_invitations AS invitation
      WHERE identity_auth.invitation_id = invitation.id
        AND identity_auth.state_sha256 = $1
        AND identity_auth.browser_binding_sha256 = $2
        AND identity_auth.status = 'PENDING' AND identity_auth.expires_at > $3
        AND invitation.status = 'PENDING' AND invitation.expires_at > $3
      RETURNING identity_auth.id AS authorization_id, invitation.id AS invitation_id,
        identity_auth.cognito_subject, invitation.tenant_id,
        invitation.invited_slack_user_id, invitation.role,
        identity_auth.nonce_sha256, identity_auth.redirect_uri
    `,
      [input.stateSha256, input.browserBindingSha256, input.consumedAt],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          authorizationId: row.authorization_id,
          invitationId: row.invitation_id,
          cognitoSubject: row.cognito_subject,
          tenantId: row.tenant_id,
          invitedSlackUserId: row.invited_slack_user_id,
          role: row.role,
          nonceSha256: row.nonce_sha256,
          redirectUri: row.redirect_uri,
        };
  }

  public async completeIdentityAuthorization(
    input: Parameters<
      WorkspaceAccessRepository['completeIdentityAuthorization']
    >[0],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.completeInTransaction(client, input);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((error as DatabaseError).code === '23505')
        throw new WorkspaceAccessRepositoryError('IDENTITY_CONFLICT');
      throw error;
    } finally {
      client.release();
    }
  }

  private async completeInTransaction(
    client: PoolClient,
    input: Parameters<
      WorkspaceAccessRepository['completeIdentityAuthorization']
    >[0],
  ): Promise<void> {
    const accepted = await client.query(
      `
      UPDATE workspace_invitations AS invitation
      SET status = 'ACCEPTED', accepted_by_subject = $3,
          accepted_at = $6, updated_at = $6, version = version + 1
      FROM slack_identity_authorizations AS identity_auth
      WHERE invitation.id = $2 AND identity_auth.id = $1
        AND identity_auth.invitation_id = invitation.id
        AND identity_auth.cognito_subject = $3
        AND invitation.tenant_id = $4 AND invitation.invited_slack_user_id = $5
        AND invitation.role = $7 AND invitation.status = 'PENDING'
        AND identity_auth.status = 'CONSUMED'
      RETURNING invitation.id
    `,
      [
        input.authorizationId,
        input.invitationId,
        input.cognitoSubject,
        input.teamId,
        input.slackUserId,
        input.completedAt,
        input.role,
      ],
    );
    if (accepted.rowCount !== 1)
      throw new WorkspaceAccessRepositoryError('INVITATION_NOT_USABLE');
    await client.query(
      `
      INSERT INTO reviewer_memberships (
        tenant_id, cognito_subject, slack_user_id, role, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5)
      ON CONFLICT (tenant_id, cognito_subject) DO UPDATE SET
        slack_user_id = EXCLUDED.slack_user_id, role = EXCLUDED.role,
        status = 'ACTIVE', updated_at = EXCLUDED.updated_at, revoked_at = NULL
    `,
      [
        input.teamId,
        input.cognitoSubject,
        input.slackUserId,
        input.role,
        input.completedAt,
      ],
    );
    await client.query(
      `
      UPDATE slack_identity_authorizations
      SET status = 'COMPLETED', completed_at = $2
      WHERE id = $1 AND status = 'CONSUMED'
    `,
      [input.authorizationId, input.completedAt],
    );
  }

  public async failIdentityAuthorization(
    input: Parameters<
      WorkspaceAccessRepository['failIdentityAuthorization']
    >[0],
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE slack_identity_authorizations
      SET status = 'FAILED', failure_code = $2, failed_at = $3
      WHERE id = $1 AND status = 'CONSUMED'
    `,
      [input.authorizationId, input.failureCode, input.failedAt],
    );
  }
}
