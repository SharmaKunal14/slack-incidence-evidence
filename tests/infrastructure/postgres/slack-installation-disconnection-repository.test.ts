import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresSlackInstallationDisconnectionRepository } from '../../../src/infrastructure/postgres/slack-installation-disconnection-repository.js';

function result<Row extends QueryResultRow>(
  rows: Row[],
  rowCount = rows.length,
): QueryResult<Row> {
  return { command: '', fields: [], oid: 0, rowCount, rows };
}

const secretArn =
  'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:incident-copilot/development/slack/installations/attempt-AbCd12';
const activeRow = {
  id: 'slack-installation:1',
  tenant_id: 'T001',
  team_id: 'T001',
  status: 'ACTIVE',
  credential_secret_arn: secretArn,
};
const common = {
  workspaceId: 'T001',
  cognitoSubject: '9f218e92-36a8-455d-869c-a76e27b399df',
  auditEventId: '0e83264c-6eb7-4c4d-97f2-c36caa8df167',
  requestId: 'request-id',
  occurredAt: new Date('2026-08-07T01:00:00.000Z'),
};

function repository(query: ReturnType<typeof vi.fn>): {
  readonly repository: PostgresSlackInstallationDisconnectionRepository;
  readonly release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return {
    repository: new PostgresSlackInstallationDisconnectionRepository(pool),
    release,
  };
}

describe('PostgresSlackInstallationDisconnectionRepository', () => {
  it('authorizes an active admin and atomically claims the installation', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([activeRow]))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([]));
    const connected = repository(query);

    await expect(connected.repository.begin(common)).resolves.toEqual({
      installationId: activeRow.id,
      tenantId: 'T001',
      workspaceId: 'T001',
      credentialSecretArn: secretArn,
      state: 'CLAIMED',
    });

    expect(query.mock.calls[1]?.[0]).toContain(
      "membership.role IN ('OWNER', 'ADMIN')",
    );
    expect(query.mock.calls[1]?.[0]).toContain("tenant.status = 'ACTIVE'");
    expect(query.mock.calls[2]?.[0]).toContain("status = 'DISCONNECTING'");
    expect(query.mock.calls[3]?.[0]).toContain('INSERT INTO audit_events');
    expect(query.mock.calls[3]?.[1]).not.toContain(secretArn);
    expect(connected.release).toHaveBeenCalledOnce();
  });

  it('resumes a claimed operation without duplicating its requested audit event', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([{ ...activeRow, status: 'DISCONNECTING' }]),
      )
      .mockResolvedValueOnce(result([]));
    const connected = repository(query);

    await expect(connected.repository.begin(common)).resolves.toMatchObject({
      state: 'RESUMED',
    });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the requester is not an active workspace admin', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]));
    const connected = repository(query);

    await expect(connected.repository.begin(common)).rejects.toMatchObject({
      code: 'ADMIN_REQUIRED',
    });
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('clears the credential reference only while finalizing the claimed state', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([{ ...activeRow, status: 'DISCONNECTING' }]),
      )
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([]));
    const connected = repository(query);

    await expect(
      connected.repository.complete({
        claim: {
          installationId: activeRow.id,
          tenantId: 'T001',
          workspaceId: 'T001',
          credentialSecretArn: secretArn,
          state: 'CLAIMED',
        },
        cognitoSubject: common.cognitoSubject,
        auditEventId: common.auditEventId,
        requestId: common.requestId,
        slackUninstallOutcome: 'UNINSTALLED',
        secretDeletionScheduled: true,
        occurredAt: common.occurredAt,
      }),
    ).resolves.toEqual({ idempotent: false });

    expect(query.mock.calls[2]?.[0]).toContain("status = 'REVOKED'");
    expect(query.mock.calls[2]?.[0]).toContain('credential_secret_arn = NULL');
    expect(query.mock.calls[2]?.[0]).toContain(
      "status IN ('DISCONNECTING', 'REVOKED')",
    );
    expect(query.mock.calls[3]?.[1]).toContain(
      'SLACK_INSTALLATION_DISCONNECTED',
    );
  });
});
