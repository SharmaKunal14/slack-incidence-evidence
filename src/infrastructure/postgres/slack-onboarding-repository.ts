import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { z } from 'zod';
import {
  completeSlackInstallationSchema,
  consumeSlackOAuthAuthorizationSchema,
  createSlackOAuthAuthorizationSchema,
  failSlackOAuthAuthorizationSchema,
} from '../../application/onboarding/slack-installation.js';
import { SlackOnboardingRepositoryError } from '../../application/ports/slack-onboarding-repository.js';
import type {
  CompleteSlackInstallationInput,
  ClaimedSlackOAuthAuthorization,
  ConsumeSlackOAuthAuthorizationInput,
  CreateSlackOAuthAuthorizationInput,
  FailSlackOAuthAuthorizationInput,
  SlackInstallationCompletion,
  SlackOnboardingRepository,
} from '../../application/ports/slack-onboarding-repository.js';

interface AuthorizationRow extends QueryResultRow {
  readonly status: 'CONSUMED' | 'COMPLETED';
  readonly id: string;
  readonly cognito_subject: string;
  readonly redirect_uri: string;
  readonly requested_scopes: string[];
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
  readonly consumed_at: Date | string;
  readonly completed_installation_id: string | null;
  readonly completion_kind: 'CREATED' | 'REINSTALLED' | null;
  readonly completed_team_id: string | null;
}

interface CompletionAuthorizationRow extends QueryResultRow {
  readonly status: 'CONSUMED' | 'COMPLETED';
  readonly completed_installation_id: string | null;
  readonly completion_kind: 'CREATED' | 'REINSTALLED' | null;
  readonly completed_team_id: string | null;
}

interface InstallationRow extends QueryResultRow {
  readonly id: string;
  readonly tenant_id: string;
}

interface TenantRow extends QueryResultRow {
  readonly id: string;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
}

interface AdminMembershipRow extends QueryResultRow {
  readonly slack_user_id: string | null;
}

const WORKSPACE_ADVISORY_LOCK_NAMESPACE = 1_249_227_793;

export class SlackOnboardingAuthorizationError extends SlackOnboardingRepositoryError {
  public constructor() {
    super(
      'AUTHORIZATION_NOT_USABLE',
      'Slack onboarding authorization is not usable',
    );
    this.name = 'SlackOnboardingAuthorizationError';
  }
}

export class SlackOnboardingAdminRequiredError extends SlackOnboardingRepositoryError {
  public constructor() {
    super('ADMIN_REQUIRED', 'An active tenant administrator is required');
    this.name = 'SlackOnboardingAdminRequiredError';
  }
}

export class SlackOnboardingIdentityConflictError extends SlackOnboardingRepositoryError {
  public constructor() {
    super(
      'IDENTITY_CONFLICT',
      'The Slack user is already bound to another reviewer identity',
    );
    this.name = 'SlackOnboardingIdentityConflictError';
  }
}

/** PostgreSQL persistence boundary for one-time OAuth state and installation authority. */
export class PostgresSlackOnboardingRepository implements SlackOnboardingRepository {
  public constructor(private readonly pool: Pool) {}

  public async createAuthorization(
    rawInput: CreateSlackOAuthAuthorizationInput,
  ): Promise<void> {
    const input = createSlackOAuthAuthorizationSchema.parse(rawInput);
    await this.pool.query(
      `
        INSERT INTO slack_oauth_authorizations (
          id,
          state_sha256,
          browser_binding_sha256,
          cognito_subject,
          redirect_uri,
          requested_scopes,
          status,
          created_at,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8)
      `,
      [
        input.id,
        input.stateSha256,
        input.browserBindingSha256,
        input.cognitoSubject,
        input.redirectUri,
        input.requestedScopes,
        input.createdAt,
        input.expiresAt,
      ],
    );
  }

  public async consumeAuthorization(
    rawInput: ConsumeSlackOAuthAuthorizationInput,
  ): Promise<ClaimedSlackOAuthAuthorization | null> {
    const input = consumeSlackOAuthAuthorizationSchema.parse(rawInput);
    const result = await this.pool.query<AuthorizationRow>(
      `
        WITH consumed AS (
          UPDATE slack_oauth_authorizations
          SET status = 'CONSUMED',
              consumed_at = $3
          WHERE state_sha256 = $1
            AND browser_binding_sha256 = $2
            AND status = 'PENDING'
            AND created_at <= $3
            AND expires_at > $3
          RETURNING *
        )
        SELECT
          consumed.status,
          consumed.id,
          consumed.cognito_subject,
          consumed.redirect_uri,
          consumed.requested_scopes,
          consumed.created_at,
          consumed.expires_at,
          consumed.consumed_at,
          consumed.completed_installation_id,
          consumed.completion_kind,
          NULL::TEXT AS completed_team_id
        FROM consumed
        UNION ALL
        SELECT
          authorization.status,
          authorization.id,
          authorization.cognito_subject,
          authorization.redirect_uri,
          authorization.requested_scopes,
          authorization.created_at,
          authorization.expires_at,
          authorization.consumed_at,
          authorization.completed_installation_id,
          authorization.completion_kind,
          installation.team_id AS completed_team_id
        FROM slack_oauth_authorizations authorization
        JOIN slack_installations installation
          ON installation.id = authorization.completed_installation_id
        WHERE authorization.state_sha256 = $1
          AND authorization.browser_binding_sha256 = $2
          AND authorization.status = 'COMPLETED'
          AND authorization.expires_at > $3
          AND NOT EXISTS (SELECT 1 FROM consumed)
        LIMIT 1
      `,
      [input.stateSha256, input.browserBindingSha256, input.consumedAt],
    );
    const row = result.rows[0];
    return row === undefined ? null : toClaimedAuthorization(row);
  }

  public async failAuthorization(
    rawInput: FailSlackOAuthAuthorizationInput,
  ): Promise<void> {
    const input = failSlackOAuthAuthorizationSchema.parse(rawInput);
    const result = await this.pool.query(
      `
        UPDATE slack_oauth_authorizations
        SET status = 'FAILED',
            failure_code = $3,
            failed_at = COALESCE(failed_at, $4)
        WHERE id = $1
          AND cognito_subject = $2
          AND (
            status = 'CONSUMED'
            OR (status = 'FAILED' AND failure_code = $3)
          )
          AND consumed_at <= $4
      `,
      [
        input.authorizationId,
        input.cognitoSubject,
        input.failureCode,
        input.failedAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new SlackOnboardingAuthorizationError();
    }
  }

  public async completeInstallation(
    rawInput: CompleteSlackInstallationInput,
  ): Promise<SlackInstallationCompletion> {
    const input = completeSlackInstallationSchema.parse(rawInput);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authorization = await lockAuthorization(client, input);
      if (authorization.status === 'COMPLETED') {
        const completion = completedAuthorizationResult(authorization, input);
        await client.query('COMMIT');
        return completion;
      }

      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, $2))',
        [input.teamId, WORKSPACE_ADVISORY_LOCK_NAMESPACE],
      );
      const installationResult = await client.query<InstallationRow>(
        `
          SELECT id, tenant_id
          FROM slack_installations
          WHERE team_id = $1
          FOR UPDATE
        `,
        [input.teamId],
      );
      const existingInstallation = installationResult.rows[0];
      if (
        existingInstallation !== undefined &&
        existingInstallation.tenant_id !== input.teamId
      ) {
        throw new SlackOnboardingAuthorizationError();
      }
      const tenantId = existingInstallation?.tenant_id ?? input.teamId;
      const tenantResult = await client.query<TenantRow>(
        `
          SELECT id, status
          FROM tenants
          WHERE id = $1
          FOR UPDATE
        `,
        [tenantId],
      );
      const existingTenant = tenantResult.rows[0];
      const kind =
        existingTenant === undefined && existingInstallation === undefined
          ? 'CREATED'
          : 'REINSTALLED';

      if (kind === 'CREATED') {
        await createTenantAndFirstAdmin(client, input);
      } else {
        if (existingTenant?.status !== 'ACTIVE') {
          throw new SlackOnboardingAdminRequiredError();
        }
        await requireAndBindExistingAdmin(client, tenantId, input);
        await client.query(
          `
            UPDATE tenants
            SET display_name = $1,
                updated_at = $2
            WHERE id = $3
              AND status = 'ACTIVE'
          `,
          [input.teamName, input.completedAt, tenantId],
        );
      }

      const installationId = existingInstallation?.id ?? input.installationId;
      if (existingInstallation === undefined) {
        await insertInstallation(client, input, tenantId, installationId);
      } else {
        await replaceInstallation(client, input, installationId);
      }
      await markAuthorizationCompleted(client, input, installationId, kind);
      await client.query('COMMIT');
      return { installationId, tenantId, kind, idempotent: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function lockAuthorization(
  client: PoolClient,
  input: z.output<typeof completeSlackInstallationSchema>,
): Promise<CompletionAuthorizationRow> {
  const result = await client.query<CompletionAuthorizationRow>(
    `
      SELECT
        authorization.status,
        authorization.completed_installation_id,
        authorization.completion_kind,
        installation.team_id AS completed_team_id
      FROM slack_oauth_authorizations authorization
      LEFT JOIN slack_installations installation
        ON installation.id = authorization.completed_installation_id
      WHERE authorization.id = $1
        AND authorization.cognito_subject = $2
        AND authorization.status IN ('CONSUMED', 'COMPLETED')
      FOR UPDATE OF authorization
    `,
    [input.authorizationId, input.cognitoSubject],
  );
  const authorization = result.rows[0];
  if (authorization === undefined) {
    throw new SlackOnboardingAuthorizationError();
  }
  return authorization;
}

function completedAuthorizationResult(
  authorization: CompletionAuthorizationRow,
  input: z.output<typeof completeSlackInstallationSchema>,
): SlackInstallationCompletion {
  if (
    authorization.completed_installation_id === null ||
    authorization.completion_kind === null ||
    authorization.completed_team_id !== input.teamId
  ) {
    throw new SlackOnboardingAuthorizationError();
  }
  return {
    installationId: authorization.completed_installation_id,
    tenantId: input.teamId,
    kind: authorization.completion_kind,
    idempotent: true,
  };
}

async function createTenantAndFirstAdmin(
  client: PoolClient,
  input: z.output<typeof completeSlackInstallationSchema>,
): Promise<void> {
  await client.query(
    `
      INSERT INTO tenants (id, display_name, status, created_at, updated_at)
      VALUES ($1, $2, 'ACTIVE', $3, $3)
    `,
    [input.teamId, input.teamName, input.completedAt],
  );
  await client.query(
    `
      INSERT INTO reviewer_memberships (
        tenant_id,
        cognito_subject,
        slack_user_id,
        role,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'ADMIN', 'ACTIVE', $4, $4)
    `,
    [
      input.teamId,
      input.cognitoSubject,
      input.authedSlackUserId,
      input.completedAt,
    ],
  );
}

async function requireAndBindExistingAdmin(
  client: PoolClient,
  tenantId: string,
  input: z.output<typeof completeSlackInstallationSchema>,
): Promise<void> {
  const membership = await client.query<AdminMembershipRow>(
    `
      SELECT slack_user_id
      FROM reviewer_memberships
      WHERE tenant_id = $1
        AND cognito_subject = $2
        AND role = 'ADMIN'
        AND status = 'ACTIVE'
      FOR UPDATE
    `,
    [tenantId, input.cognitoSubject],
  );
  const admin = membership.rows[0];
  if (admin === undefined) {
    throw new SlackOnboardingAdminRequiredError();
  }
  if (
    admin.slack_user_id !== null &&
    admin.slack_user_id !== input.authedSlackUserId
  ) {
    throw new SlackOnboardingIdentityConflictError();
  }
  const identityOwner = await client.query<{
    readonly cognito_subject: string;
  }>(
    `
      SELECT cognito_subject
      FROM reviewer_memberships
      WHERE tenant_id = $1
        AND slack_user_id = $2
      FOR UPDATE
    `,
    [tenantId, input.authedSlackUserId],
  );
  const owner = identityOwner.rows[0]?.cognito_subject;
  if (owner !== undefined && owner !== input.cognitoSubject) {
    throw new SlackOnboardingIdentityConflictError();
  }
  await client.query(
    `
      UPDATE reviewer_memberships
      SET slack_user_id = COALESCE(slack_user_id, $1),
          updated_at = $2
      WHERE tenant_id = $3
        AND cognito_subject = $4
        AND role = 'ADMIN'
        AND status = 'ACTIVE'
    `,
    [
      input.authedSlackUserId,
      input.completedAt,
      tenantId,
      input.cognitoSubject,
    ],
  );
}

async function insertInstallation(
  client: PoolClient,
  input: z.output<typeof completeSlackInstallationSchema>,
  tenantId: string,
  installationId: string,
): Promise<void> {
  await client.query(
    `
      INSERT INTO slack_installations (
        id,
        tenant_id,
        team_id,
        enterprise_id,
        app_id,
        bot_user_id,
        installed_by_user_id,
        bot_token_ciphertext,
        encryption_key_id,
        granted_scopes,
        installed_at,
        updated_at,
        revoked_at,
        status,
        credential_secret_arn,
        credential_expires_at,
        installed_by_cognito_subject,
        last_error_code,
        version
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8, $9, $9, NULL,
        'ACTIVE', $10, $11, $12, NULL, 0
      )
    `,
    [
      installationId,
      tenantId,
      input.teamId,
      input.enterpriseId,
      input.appId,
      input.botUserId,
      input.authedSlackUserId,
      input.grantedScopes,
      input.completedAt,
      input.credentialSecretArn,
      input.credentialExpiresAt,
      input.cognitoSubject,
    ],
  );
}

async function replaceInstallation(
  client: PoolClient,
  input: z.output<typeof completeSlackInstallationSchema>,
  installationId: string,
): Promise<void> {
  await client.query(
    `
      UPDATE slack_installations
      SET enterprise_id = $1,
          app_id = $2,
          bot_user_id = $3,
          installed_by_user_id = $4,
          bot_token_ciphertext = NULL,
          encryption_key_id = NULL,
          granted_scopes = $5,
          updated_at = $6,
          revoked_at = NULL,
          status = 'ACTIVE',
          credential_secret_arn = $7,
          credential_expires_at = $8,
          installed_by_cognito_subject = $9,
          last_error_code = NULL,
          version = version + 1
      WHERE id = $10
        AND team_id = $11
    `,
    [
      input.enterpriseId,
      input.appId,
      input.botUserId,
      input.authedSlackUserId,
      input.grantedScopes,
      input.completedAt,
      input.credentialSecretArn,
      input.credentialExpiresAt,
      input.cognitoSubject,
      installationId,
      input.teamId,
    ],
  );
}

async function markAuthorizationCompleted(
  client: PoolClient,
  input: z.output<typeof completeSlackInstallationSchema>,
  installationId: string,
  kind: 'CREATED' | 'REINSTALLED',
): Promise<void> {
  const result = await client.query(
    `
      UPDATE slack_oauth_authorizations
      SET status = 'COMPLETED',
          completed_at = $1,
          completed_installation_id = $2,
          completion_kind = $3
      WHERE id = $4
        AND cognito_subject = $5
        AND status = 'CONSUMED'
    `,
    [
      input.completedAt,
      installationId,
      kind,
      input.authorizationId,
      input.cognitoSubject,
    ],
  );
  if (result.rowCount !== 1) {
    throw new SlackOnboardingAuthorizationError();
  }
}

function toClaimedAuthorization(
  row: AuthorizationRow,
): ClaimedSlackOAuthAuthorization {
  if (row.status === 'COMPLETED') {
    if (
      row.completed_installation_id === null ||
      row.completion_kind === null ||
      row.completed_team_id === null
    ) {
      throw new SlackOnboardingAuthorizationError();
    }
    return {
      status: 'COMPLETED',
      id: row.id,
      completion: {
        installationId: row.completed_installation_id,
        tenantId: row.completed_team_id,
        kind: row.completion_kind,
        idempotent: true,
      },
    };
  }
  return {
    status: 'CONSUMED',
    id: row.id,
    cognitoSubject: row.cognito_subject,
    redirectUri: row.redirect_uri,
    requestedScopes: row.requested_scopes,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
    consumedAt: toDate(row.consumed_at),
  };
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid onboarding timestamp returned by PostgreSQL');
  }
  return date;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original error; pool-level logging owns rollback failures.
  }
}
