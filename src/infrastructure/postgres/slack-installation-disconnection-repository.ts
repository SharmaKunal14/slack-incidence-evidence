import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { slackInstallationSecretArnSchema } from '../../application/onboarding/slack-installation.js';
import {
  SlackInstallationDisconnectionRepositoryError,
  type SlackInstallationDisconnectClaim,
  type SlackInstallationDisconnectionRepository,
} from '../../application/ports/slack-installation-disconnection-repository.js';

const workspaceIdSchema = z.string().regex(/^T[A-Z0-9]{1,63}$/u);
const subjectSchema = z.uuid();
const auditIdSchema = z.uuid();
const requestIdSchema = z.string().trim().min(1).max(256);
const safeErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u);

interface InstallationRow extends QueryResultRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly team_id: string;
  readonly status:
    | 'PENDING'
    | 'ACTIVE'
    | 'RECONNECT_REQUIRED'
    | 'DISCONNECTING'
    | 'REVOKED'
    | 'FAILED';
  readonly credential_secret_arn: string | null;
}

/** Transactional authority and audit boundary for Slack disconnection. */
export class PostgresSlackInstallationDisconnectionRepository implements SlackInstallationDisconnectionRepository {
  public constructor(private readonly pool: Pool) {}

  public async begin(input: {
    readonly workspaceId: string;
    readonly cognitoSubject: string;
    readonly auditEventId: string;
    readonly requestId: string;
    readonly occurredAt: Date;
  }): Promise<SlackInstallationDisconnectClaim> {
    const parsed = parseCommonInput(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const installation = await lockAuthorizedInstallation(
        client,
        parsed.workspaceId,
        parsed.cognitoSubject,
      );
      const secretArn = parseOptionalSecretArn(
        installation.credential_secret_arn,
      );
      if (installation.status === 'REVOKED') {
        await client.query('COMMIT');
        return toClaim(installation, secretArn, 'ALREADY_DISCONNECTED');
      }
      if (installation.status === 'DISCONNECTING') {
        await client.query('COMMIT');
        return toClaim(installation, secretArn, 'RESUMED');
      }
      if (
        installation.status !== 'ACTIVE' &&
        installation.status !== 'RECONNECT_REQUIRED' &&
        installation.status !== 'FAILED'
      ) {
        throw new SlackInstallationDisconnectionRepositoryError('CONFLICT');
      }
      const updated = await client.query(
        `
          UPDATE slack_installations
          SET status = 'DISCONNECTING',
              updated_at = $1,
              last_error_code = NULL,
              version = version + 1
          WHERE id = $2
            AND team_id = $3
            AND status = $4
        `,
        [
          parsed.occurredAt,
          installation.id,
          parsed.workspaceId,
          installation.status,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new SlackInstallationDisconnectionRepositoryError('CONFLICT');
      }
      await insertAuditEvent(client, {
        id: parsed.auditEventId,
        tenantId: installation.tenant_id,
        actorId: parsed.cognitoSubject,
        action: 'SLACK_INSTALLATION_DISCONNECT_REQUESTED',
        targetId: installation.id,
        requestId: parsed.requestId,
        metadata: { workspaceId: parsed.workspaceId },
        occurredAt: parsed.occurredAt,
      });
      await client.query('COMMIT');
      return toClaim(installation, secretArn, 'CLAIMED');
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async complete(input: {
    readonly claim: SlackInstallationDisconnectClaim;
    readonly cognitoSubject: string;
    readonly auditEventId: string;
    readonly requestId: string;
    readonly slackUninstallOutcome:
      'UNINSTALLED' | 'ALREADY_UNINSTALLED' | 'CREDENTIAL_UNAVAILABLE';
    readonly secretDeletionScheduled: boolean;
    readonly occurredAt: Date;
  }): Promise<{ readonly idempotent: boolean }> {
    const parsed = {
      ...parseClaim(input.claim),
      cognitoSubject: subjectSchema.parse(input.cognitoSubject),
      auditEventId: auditIdSchema.parse(input.auditEventId),
      requestId: requestIdSchema.parse(input.requestId),
      uninstallOutcome: z
        .enum(['UNINSTALLED', 'ALREADY_UNINSTALLED', 'CREDENTIAL_UNAVAILABLE'])
        .parse(input.slackUninstallOutcome),
      secretDeletionScheduled: z.boolean().parse(input.secretDeletionScheduled),
      occurredAt: validDate(input.occurredAt),
    };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await lockClaimedInstallation(client, parsed);
      if (
        current.status === 'REVOKED' &&
        current.credential_secret_arn === null
      ) {
        await client.query('COMMIT');
        return { idempotent: true };
      }
      if (current.status !== 'DISCONNECTING' && current.status !== 'REVOKED') {
        throw new SlackInstallationDisconnectionRepositoryError('CONFLICT');
      }
      const updated = await client.query(
        `
          UPDATE slack_installations
          SET status = 'REVOKED',
              revoked_at = COALESCE(revoked_at, $1),
              updated_at = $1,
              credential_secret_arn = NULL,
              credential_expires_at = NULL,
              last_error_code = NULL,
              version = version + 1
          WHERE id = $2
            AND team_id = $3
            AND credential_secret_arn IS NOT DISTINCT FROM $4
            AND status IN ('DISCONNECTING', 'REVOKED')
        `,
        [
          parsed.occurredAt,
          parsed.installationId,
          parsed.workspaceId,
          parsed.credentialSecretArn,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new SlackInstallationDisconnectionRepositoryError('CONFLICT');
      }
      await insertAuditEvent(client, {
        id: parsed.auditEventId,
        tenantId: parsed.tenantId,
        actorId: parsed.cognitoSubject,
        action: 'SLACK_INSTALLATION_DISCONNECTED',
        targetId: parsed.installationId,
        requestId: parsed.requestId,
        metadata: {
          workspaceId: parsed.workspaceId,
          slackUninstallOutcome: parsed.uninstallOutcome,
          secretDeletionScheduled: parsed.secretDeletionScheduled,
        },
        occurredAt: parsed.occurredAt,
      });
      await client.query('COMMIT');
      return { idempotent: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordFailure(input: {
    readonly claim: SlackInstallationDisconnectClaim;
    readonly cognitoSubject: string;
    readonly auditEventId: string;
    readonly requestId: string;
    readonly failureCode: string;
    readonly retryable: boolean;
    readonly occurredAt: Date;
  }): Promise<void> {
    const claim = parseClaim(input.claim);
    const subject = subjectSchema.parse(input.cognitoSubject);
    const auditEventId = auditIdSchema.parse(input.auditEventId);
    const requestId = requestIdSchema.parse(input.requestId);
    const failureCode = safeErrorCodeSchema.parse(input.failureCode);
    const retryable = z.boolean().parse(input.retryable);
    const occurredAt = validDate(input.occurredAt);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `
          UPDATE slack_installations
          SET last_error_code = $1,
              updated_at = $2,
              version = version + 1
          WHERE id = $3
            AND team_id = $4
            AND credential_secret_arn IS NOT DISTINCT FROM $5
            AND status = 'DISCONNECTING'
        `,
        [
          failureCode,
          occurredAt,
          claim.installationId,
          claim.workspaceId,
          claim.credentialSecretArn,
        ],
      );
      if (updated.rowCount === 1) {
        await insertAuditEvent(client, {
          id: auditEventId,
          tenantId: claim.tenantId,
          actorId: subject,
          action: 'SLACK_INSTALLATION_DISCONNECT_FAILED',
          targetId: claim.installationId,
          requestId,
          metadata: {
            workspaceId: claim.workspaceId,
            failureCode,
            retryable,
          },
          occurredAt,
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function lockAuthorizedInstallation(
  client: PoolClient,
  workspaceId: string,
  cognitoSubject: string,
): Promise<InstallationRow> {
  const result = await client.query<InstallationRow>(
    `
      SELECT
        installation.id,
        installation.tenant_id,
        installation.team_id,
        installation.status,
        installation.credential_secret_arn
      FROM slack_installations AS installation
      JOIN tenants AS tenant
        ON tenant.id = installation.tenant_id
       AND tenant.status = 'ACTIVE'
      JOIN reviewer_memberships AS membership
        ON membership.tenant_id = installation.tenant_id
       AND membership.cognito_subject = $2
       AND membership.role IN ('OWNER', 'ADMIN')
       AND membership.status = 'ACTIVE'
      WHERE installation.team_id = $1
        AND installation.tenant_id = $1
      FOR UPDATE OF installation
    `,
    [workspaceId, cognitoSubject],
  );
  const installation = result.rows[0];
  if (installation === undefined || result.rows.length !== 1) {
    throw new SlackInstallationDisconnectionRepositoryError('ADMIN_REQUIRED');
  }
  return installation;
}

async function lockClaimedInstallation(
  client: PoolClient,
  claim: ReturnType<typeof parseClaim>,
): Promise<InstallationRow> {
  const result = await client.query<InstallationRow>(
    `
      SELECT id, tenant_id, team_id, status, credential_secret_arn
      FROM slack_installations
      WHERE id = $1
        AND tenant_id = $2
        AND team_id = $3
      FOR UPDATE
    `,
    [claim.installationId, claim.tenantId, claim.workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined || result.rows.length !== 1) {
    throw new SlackInstallationDisconnectionRepositoryError('CONFLICT');
  }
  return row;
}

async function insertAuditEvent(
  client: PoolClient,
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly actorId: string;
    readonly action: string;
    readonly targetId: string;
    readonly requestId: string;
    readonly metadata: Readonly<Record<string, string | boolean>>;
    readonly occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO audit_events (
        id,
        tenant_id,
        incident_id,
        actor_type,
        actor_id,
        action,
        target_type,
        target_id,
        request_id,
        metadata,
        occurred_at
      )
      VALUES ($1, $2, NULL, 'USER', $3, $4, 'SLACK_INSTALLATION', $5, $6, $7::jsonb, $8)
    `,
    [
      input.id,
      input.tenantId,
      input.actorId,
      input.action,
      input.targetId,
      input.requestId,
      JSON.stringify(input.metadata),
      input.occurredAt,
    ],
  );
}

function parseCommonInput(input: {
  readonly workspaceId: string;
  readonly cognitoSubject: string;
  readonly auditEventId: string;
  readonly requestId: string;
  readonly occurredAt: Date;
}): {
  readonly workspaceId: string;
  readonly cognitoSubject: string;
  readonly auditEventId: string;
  readonly requestId: string;
  readonly occurredAt: Date;
} {
  return {
    workspaceId: workspaceIdSchema.parse(input.workspaceId),
    cognitoSubject: subjectSchema.parse(input.cognitoSubject),
    auditEventId: auditIdSchema.parse(input.auditEventId),
    requestId: requestIdSchema.parse(input.requestId),
    occurredAt: validDate(input.occurredAt),
  };
}

function parseClaim(claim: SlackInstallationDisconnectClaim): {
  readonly installationId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly credentialSecretArn: string | null;
  readonly state: SlackInstallationDisconnectClaim['state'];
} {
  return {
    installationId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .parse(claim.installationId),
    tenantId: workspaceIdSchema.parse(claim.tenantId),
    workspaceId: workspaceIdSchema.parse(claim.workspaceId),
    credentialSecretArn: parseOptionalSecretArn(claim.credentialSecretArn),
    state: z
      .enum(['CLAIMED', 'RESUMED', 'ALREADY_DISCONNECTED'])
      .parse(claim.state),
  };
}

function parseOptionalSecretArn(value: string | null): string | null {
  return value === null ? null : slackInstallationSecretArnSchema.parse(value);
}

function toClaim(
  installation: InstallationRow,
  credentialSecretArn: string | null,
  state: SlackInstallationDisconnectClaim['state'],
): SlackInstallationDisconnectClaim {
  return {
    installationId: installation.id,
    tenantId: installation.tenant_id,
    workspaceId: installation.team_id,
    credentialSecretArn,
    state,
  };
}

function validDate(value: Date): Date {
  if (Number.isNaN(value.getTime())) {
    throw new Error('Invalid Slack disconnection timestamp');
  }
  return value;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original transactional failure.
  }
}
