import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresWorkspaceAccessRepository } from '../../../src/infrastructure/postgres/workspace-access-repository.js';

function result<Row extends QueryResultRow>(
  rows: Row[],
  rowCount = rows.length,
): QueryResult<Row> {
  return { command: '', fields: [], oid: 0, rowCount, rows };
}

describe('PostgresWorkspaceAccessRepository', () => {
  it('consumes a pending identity authorization without using a reserved SQL alias', async () => {
    const consumedAt = new Date('2026-08-08T05:59:49.000Z');
    const query = vi.fn().mockResolvedValue(
      result([
        {
          authorization_id: '6cbebce1-a63d-4bef-8d9c-882ee3a292db',
          invitation_id: 'f0e4df57-a1f6-4593-baa1-9f1621b59d66',
          cognito_subject: 'cognito-subject',
          tenant_id: 'T0BFS10GP27',
          invited_slack_user_id: 'U0BK2CD93FA',
          role: 'REVIEWER' as const,
          nonce_sha256: 'a'.repeat(64),
          redirect_uri:
            'https://app.example.test/onboarding/slack/identity/callback',
        },
      ]),
    );
    const repository = new PostgresWorkspaceAccessRepository({
      query,
    } as unknown as Pool);

    await expect(
      repository.consumeIdentityAuthorization({
        stateSha256: 'b'.repeat(64),
        browserBindingSha256: 'c'.repeat(64),
        consumedAt,
      }),
    ).resolves.toMatchObject({
      tenantId: 'T0BFS10GP27',
      invitedSlackUserId: 'U0BK2CD93FA',
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain(
      'UPDATE slack_identity_authorizations AS identity_auth',
    );
    expect(sql).not.toMatch(
      /slack_identity_authorizations(?:\s+AS)?\s+authorization\b/u,
    );
    expect(query.mock.calls[0]?.[1]).toEqual([
      'b'.repeat(64),
      'c'.repeat(64),
      consumedAt,
    ]);
  });

  it('accepts an identity-bound invitation without using a reserved SQL alias', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ id: 'invitation-id' }]))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([]));
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const repository = new PostgresWorkspaceAccessRepository({
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool);

    await expect(
      repository.completeIdentityAuthorization({
        authorizationId: '6cbebce1-a63d-4bef-8d9c-882ee3a292db',
        invitationId: 'f0e4df57-a1f6-4593-baa1-9f1621b59d66',
        cognitoSubject: 'cognito-subject',
        teamId: 'T0BFS10GP27',
        slackUserId: 'U0BK2CD93FA',
        role: 'REVIEWER',
        completedAt: new Date('2026-08-08T06:00:00.000Z'),
      }),
    ).resolves.toBeUndefined();

    const acceptanceSql = String(query.mock.calls[1]?.[0]);
    expect(acceptanceSql).toContain(
      'FROM slack_identity_authorizations AS identity_auth',
    );
    expect(acceptanceSql).not.toMatch(
      /slack_identity_authorizations(?:\s+AS)?\s+authorization\b/u,
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });
});
