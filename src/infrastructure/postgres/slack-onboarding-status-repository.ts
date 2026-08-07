import type { Pool, QueryResultRow } from 'pg';
import type {
  SlackConnectionStatus,
  SlackOnboardingStatus,
  SlackOnboardingStatusRepository,
  SlackOnboardingWorkspaceStatus,
} from '../../application/ports/slack-onboarding-status-repository.js';

const MAX_MEMBERSHIPS = 50;

interface StatusRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly tenant_status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  readonly role: 'OWNER' | 'ADMIN' | 'REVIEWER' | 'VIEWER';
  readonly membership_status: 'ACTIVE' | 'REVOKED';
  readonly team_id: string | null;
  readonly installation_status:
    | 'PENDING'
    | 'ACTIVE'
    | 'RECONNECT_REQUIRED'
    | 'DISCONNECTING'
    | 'REVOKED'
    | 'FAILED'
    | null;
  readonly installed_at: Date | string | null;
  readonly connection_updated_at: Date | string;
  readonly credential_expires_at: Date | string | null;
}

/** Membership-scoped read model for the customer-facing Slack connection UI. */
export class PostgresSlackOnboardingStatusRepository implements SlackOnboardingStatusRepository {
  public constructor(private readonly pool: Pick<Pool, 'query'>) {}

  public async findByCognitoSubject(
    cognitoSubject: string,
  ): Promise<SlackOnboardingStatus> {
    const result = await this.pool.query<StatusRow>(
      `
        SELECT
          membership.tenant_id,
          tenant.display_name,
          tenant.status AS tenant_status,
          membership.role,
          membership.status AS membership_status,
          installation.team_id,
          installation.status AS installation_status,
          installation.installed_at,
          COALESCE(installation.updated_at, tenant.updated_at)
            AS connection_updated_at,
          installation.credential_expires_at
        FROM reviewer_memberships AS membership
        JOIN tenants AS tenant
          ON tenant.id = membership.tenant_id
        LEFT JOIN slack_installations AS installation
          ON installation.tenant_id = membership.tenant_id
         AND installation.team_id = membership.tenant_id
        WHERE membership.cognito_subject = $1
        ORDER BY membership.created_at ASC, membership.tenant_id ASC
        LIMIT $2
      `,
      [cognitoSubject, MAX_MEMBERSHIPS + 1],
    );
    if (result.rows.length > MAX_MEMBERSHIPS) {
      throw new SlackOnboardingStatusConfigurationError();
    }

    const workspaces = result.rows
      .filter((row) => row.membership_status === 'ACTIVE')
      .map(toWorkspaceStatus);
    return {
      canStartInstallation:
        result.rows.length === 0 ||
        workspaces.some(({ canManage }) => canManage),
      workspaces,
    };
  }
}

export class SlackOnboardingStatusConfigurationError extends Error {
  public constructor() {
    super('Slack onboarding membership configuration is not supported');
    this.name = 'SlackOnboardingStatusConfigurationError';
  }
}

function toWorkspaceStatus(row: StatusRow): SlackOnboardingWorkspaceStatus {
  const tenantActive = row.tenant_status === 'ACTIVE';
  return {
    workspaceId: row.tenant_id,
    displayName: row.display_name,
    role: row.role,
    connectionStatus: connectionStatus(row, tenantActive),
    canManage: tenantActive && (row.role === 'OWNER' || row.role === 'ADMIN'),
    installedAt: optionalDate(row.installed_at),
    updatedAt: requiredDate(row.connection_updated_at),
    credentialExpiresAt: optionalDate(row.credential_expires_at),
  };
}

function connectionStatus(
  row: StatusRow,
  tenantActive: boolean,
): SlackConnectionStatus {
  if (!tenantActive) {
    return 'DISCONNECTED';
  }
  switch (row.installation_status) {
    case null:
      return 'NOT_CONNECTED';
    case 'PENDING':
      return 'CONNECTING';
    case 'ACTIVE':
      return 'CONNECTED';
    case 'RECONNECT_REQUIRED':
      return 'RECONNECT_REQUIRED';
    case 'DISCONNECTING':
      return 'DISCONNECTING';
    case 'REVOKED':
      return 'DISCONNECTED';
    case 'FAILED':
      return 'FAILED';
  }
}

function optionalDate(value: Date | string | null): Date | null {
  if (value === null) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new SlackOnboardingStatusConfigurationError();
  }
  return parsed;
}

function requiredDate(value: Date | string): Date {
  const parsed = optionalDate(value);
  if (parsed === null) {
    throw new SlackOnboardingStatusConfigurationError();
  }
  return parsed;
}
