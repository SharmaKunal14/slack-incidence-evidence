import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { SLACK_REQUIRED_BOT_SCOPES } from '../../../src/application/onboarding/slack-installation.js';
import type { CompleteSlackInstallationInput } from '../../../src/application/ports/slack-onboarding-repository.js';
import {
  PostgresSlackOnboardingRepository,
  SlackOnboardingAdminRequiredError,
  SlackOnboardingAuthorizationError,
  SlackOnboardingIdentityConflictError,
} from '../../../src/infrastructure/postgres/slack-onboarding-repository.js';

function result<Row extends QueryResultRow>(
  rows: Row[],
  rowCount = rows.length,
): QueryResult<Row> {
  return { command: '', fields: [], oid: 0, rowCount, rows };
}

const authorizationId = 'b5ce083c-6f22-4c8d-87fc-d23a8d2aa92c';
const stateSha256 = 'a'.repeat(64);
const browserBindingSha256 = 'b'.repeat(64);
const cognitoSubject = 'cognito-user-1';
const completedAt = new Date('2026-08-05T01:01:00.000Z');
const credentialSecretArn =
  'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:onrecord/slack/T001-AbCd12';

const completionInput: CompleteSlackInstallationInput = {
  authorizationId,
  installationId: 'installation:T001',
  cognitoSubject,
  teamId: 'T001',
  teamName: 'Acme Engineering',
  enterpriseId: null,
  appId: 'A001',
  botUserId: 'U001',
  authedSlackUserId: 'U002',
  credentialSecretArn,
  credentialExpiresAt: new Date('2026-08-05T13:00:00.000Z'),
  grantedScopes: [...SLACK_REQUIRED_BOT_SCOPES],
  completedAt,
};

function connectedRepository(query: ReturnType<typeof vi.fn>): {
  readonly repository: PostgresSlackOnboardingRepository;
  readonly release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return {
    repository: new PostgresSlackOnboardingRepository(pool),
    release,
  };
}

describe('PostgresSlackOnboardingRepository', () => {
  it('persists only hashed OAuth state and atomically consumes every binding', async () => {
    const createdAt = new Date('2026-08-05T01:00:00.000Z');
    const expiresAt = new Date('2026-08-05T01:10:00.000Z');
    const consumedAt = new Date('2026-08-05T01:00:30.000Z');
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([
          {
            status: 'CONSUMED',
            id: authorizationId,
            cognito_subject: cognitoSubject,
            redirect_uri: 'https://app.example.com/onboarding/slack/callback',
            requested_scopes: [...SLACK_REQUIRED_BOT_SCOPES],
            created_at: createdAt,
            expires_at: expiresAt,
            consumed_at: consumedAt,
            completed_installation_id: null,
            completion_kind: null,
            completed_team_id: null,
          },
        ]),
      );
    const pool = { query } as unknown as Pool;
    const repository = new PostgresSlackOnboardingRepository(pool);

    await repository.createAuthorization({
      id: authorizationId,
      stateSha256,
      browserBindingSha256,
      cognitoSubject,
      redirectUri: 'https://app.example.com/onboarding/slack/callback',
      requestedScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      createdAt,
      expiresAt,
    });
    await expect(
      repository.consumeAuthorization({
        stateSha256,
        browserBindingSha256,
        consumedAt,
      }),
    ).resolves.toMatchObject({ id: authorizationId, consumedAt });

    expect(query.mock.calls[0]?.[0]).toContain('state_sha256');
    expect(query.mock.calls[1]?.[0]).toContain("status = 'PENDING'");
    expect(query.mock.calls[1]?.[0]).toContain('expires_at > $3');
    expect(query.mock.calls[1]?.[1]).toEqual([
      stateSha256,
      browserBindingSha256,
      consumedAt,
    ]);
  });

  it('returns a bound completed authorization for callback replay', async () => {
    const consumedAt = new Date('2026-08-05T01:00:30.000Z');
    const query = vi.fn().mockResolvedValue(
      result([
        {
          status: 'COMPLETED',
          id: authorizationId,
          cognito_subject: cognitoSubject,
          redirect_uri: 'https://app.example.com/onboarding/slack/callback',
          requested_scopes: [...SLACK_REQUIRED_BOT_SCOPES],
          created_at: new Date('2026-08-05T01:00:00.000Z'),
          expires_at: new Date('2026-08-05T01:10:00.000Z'),
          consumed_at: consumedAt,
          completed_installation_id: 'installation:T001',
          completion_kind: 'CREATED',
          completed_team_id: 'T001',
        },
      ]),
    );
    const pool = { query } as unknown as Pool;
    const repository = new PostgresSlackOnboardingRepository(pool);

    await expect(
      repository.consumeAuthorization({
        stateSha256,
        browserBindingSha256,
        consumedAt,
      }),
    ).resolves.toEqual({
      status: 'COMPLETED',
      id: authorizationId,
      completion: {
        installationId: 'installation:T001',
        tenantId: 'T001',
        kind: 'CREATED',
        idempotent: true,
      },
    });
    expect(query.mock.calls[0]?.[0]).toContain(
      "authorization.status = 'COMPLETED'",
    );
    expect(query.mock.calls[0]?.[0]).toContain('browser_binding_sha256 = $2');
  });

  it('creates a new tenant, first admin, and secret-referenced installation transactionally', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([
          {
            status: 'CONSUMED',
            completed_installation_id: null,
            completion_kind: null,
            completed_team_id: null,
          },
        ]),
      )
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([]));
    const { repository, release } = connectedRepository(query);

    await expect(
      repository.completeInstallation(completionInput),
    ).resolves.toEqual({
      installationId: 'installation:T001',
      tenantId: 'T001',
      kind: 'CREATED',
      idempotent: false,
    });

    expect(query.mock.calls[2]?.[0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[5]?.[0]).toContain('INSERT INTO tenants');
    expect(query.mock.calls[6]?.[0]).toContain(
      'INSERT INTO reviewer_memberships',
    );
    expect(query.mock.calls[7]?.[0]).toContain(
      'INSERT INTO slack_installations',
    );
    expect(query.mock.calls[7]?.[1]).toContain(credentialSecretArn);
    expect(query.mock.calls[7]?.[1]).not.toContain(
      expect.stringMatching(/^xox/),
    );
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects an existing tenant without an active admin and rolls back', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([
          {
            status: 'CONSUMED',
            completed_installation_id: null,
            completion_kind: null,
            completed_team_id: null,
          },
        ]),
      )
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([{ id: 'installation:T001', tenant_id: 'T001' }]),
      )
      .mockResolvedValueOnce(result([{ id: 'T001', status: 'ACTIVE' }]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]));
    const { repository, release } = connectedRepository(query);

    await expect(
      repository.completeInstallation(completionInput),
    ).rejects.toBeInstanceOf(SlackOnboardingAdminRequiredError);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects a legacy installation whose tenant does not match its Slack team', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([
          {
            status: 'CONSUMED',
            completed_installation_id: null,
            completion_kind: null,
            completed_team_id: null,
          },
        ]),
      )
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([{ id: 'installation:T001', tenant_id: 'different-tenant' }]),
      )
      .mockResolvedValueOnce(result([]));
    const { repository } = connectedRepository(query);

    await expect(
      repository.completeInstallation(completionInput),
    ).rejects.toBeInstanceOf(SlackOnboardingAuthorizationError);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('rejects changing an existing administrator Slack identity', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([
          {
            status: 'CONSUMED',
            completed_installation_id: null,
            completion_kind: null,
            completed_team_id: null,
          },
        ]),
      )
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([{ id: 'installation:T001', tenant_id: 'T001' }]),
      )
      .mockResolvedValueOnce(result([{ id: 'T001', status: 'ACTIVE' }]))
      .mockResolvedValueOnce(result([{ slack_user_id: 'U999' }]))
      .mockResolvedValueOnce(result([]));
    const { repository } = connectedRepository(query);

    await expect(
      repository.completeInstallation(completionInput),
    ).rejects.toBeInstanceOf(SlackOnboardingIdentityConflictError);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('returns a completed authorization idempotently without replacing credentials', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([
          {
            status: 'COMPLETED',
            completed_installation_id: 'installation:T001',
            completion_kind: 'CREATED',
            completed_team_id: 'T001',
          },
        ]),
      )
      .mockResolvedValueOnce(result([]));
    const { repository } = connectedRepository(query);

    await expect(
      repository.completeInstallation(completionInput),
    ).resolves.toEqual({
      installationId: 'installation:T001',
      tenantId: 'T001',
      kind: 'CREATED',
      idempotent: true,
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.anything(),
    );
  });

  it('fails closed when a consumed authorization cannot be updated', async () => {
    const query = vi.fn().mockResolvedValue(result([], 0));
    const pool = { query } as unknown as Pool;
    const repository = new PostgresSlackOnboardingRepository(pool);

    await expect(
      repository.failAuthorization({
        authorizationId,
        cognitoSubject,
        failureCode: 'SLACK_CODE_EXCHANGE_FAILED',
        failedAt: completedAt,
      }),
    ).rejects.toBeInstanceOf(SlackOnboardingAuthorizationError);
  });

  it('records the same safe authorization failure idempotently', async () => {
    const query = vi.fn().mockResolvedValue(result([], 1));
    const pool = { query } as unknown as Pool;
    const repository = new PostgresSlackOnboardingRepository(pool);

    await expect(
      repository.failAuthorization({
        authorizationId,
        cognitoSubject,
        failureCode: 'SLACK_CODE_EXCHANGE_FAILED',
        failedAt: completedAt,
      }),
    ).resolves.toBeUndefined();
    expect(query.mock.calls[0]?.[0]).toContain(
      "status = 'FAILED' AND failure_code = $3",
    );
  });
});
