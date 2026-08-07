import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { Clock } from '../../../src/application/ports/clock.js';
import { SlackInstallationCredentialResolutionError } from '../../../src/application/ports/slack-installation-credential-resolver.js';
import { PostgresSecretsSlackInstallationCredentialResolver } from '../../../src/infrastructure/postgres-secrets/slack-installation-credential-resolver.js';

const workspaceId = 'T001';
const botUserId = 'U001';
const secretArn =
  'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:incident-copilot/development/slack/installations/12345678-abcd-EfGh';
const now = new Date('2026-08-07T01:00:00.000Z');
const clock: Clock = { now: () => now };

function result<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return {
    command: 'SELECT',
    fields: [],
    oid: 0,
    rowCount: rows.length,
    rows,
  };
}

function activeRow(
  overrides: Readonly<Record<string, unknown>> = {},
): QueryResultRow {
  return {
    tenant_id: workspaceId,
    team_id: workspaceId,
    bot_user_id: botUserId,
    status: 'ACTIVE',
    revoked_at: null,
    credential_secret_arn: secretArn,
    credential_expires_at: null,
    ...overrides,
  };
}

function credential(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    teamId: workspaceId,
    botUserId,
    accessToken: 'xoxb-sensitive-runtime-token',
    rotation: { mode: 'LONG_LIVED' },
    ...overrides,
  });
}

function resolver(
  input: {
    readonly query?: ReturnType<typeof vi.fn>;
    readonly readString?: ReturnType<typeof vi.fn>;
  } = {},
): {
  readonly subject: PostgresSecretsSlackInstallationCredentialResolver;
  readonly query: ReturnType<typeof vi.fn>;
  readonly readString: ReturnType<typeof vi.fn>;
} {
  const query = input.query ?? vi.fn().mockResolvedValue(result([activeRow()]));
  const readString =
    input.readString ?? vi.fn().mockResolvedValue(credential());
  return {
    subject: new PostgresSecretsSlackInstallationCredentialResolver(
      { query },
      { readString },
      clock,
    ),
    query,
    readString,
  };
}

describe('PostgresSecretsSlackInstallationCredentialResolver', () => {
  it('resolves only the active workspace-bound secret reference', async () => {
    const { subject, query, readString } = resolver();

    await expect(subject.resolve(workspaceId)).resolves.toEqual({
      workspaceId,
      botToken: 'xoxb-sensitive-runtime-token',
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE team_id = $1'),
      [workspaceId],
    );
    expect(readString).toHaveBeenCalledWith(secretArn);
  });

  it('fails closed before reading a revoked or inactive installation', async () => {
    const query = vi
      .fn()
      .mockResolvedValue(result([activeRow({ status: 'REVOKED' })]));
    const readString = vi.fn();
    const { subject } = resolver({ query, readString });

    await expect(subject.resolve(workspaceId)).rejects.toMatchObject({
      code: 'SLACK_INSTALLATION_NOT_ACTIVE',
      retryable: false,
    });
    expect(readString).not.toHaveBeenCalled();
  });

  it('rejects a secret bound to another workspace', async () => {
    const readString = vi
      .fn()
      .mockResolvedValue(credential({ teamId: 'T999' }));
    const { subject } = resolver({ readString });

    await expect(subject.resolve(workspaceId)).rejects.toMatchObject({
      code: 'SLACK_INSTALLATION_CREDENTIAL_MISMATCH',
      retryable: false,
    });
  });

  it('rejects expired rotating credentials whose metadata matches PostgreSQL', async () => {
    const expiresAt = new Date('2026-08-07T00:59:59.000Z');
    const query = vi
      .fn()
      .mockResolvedValue(
        result([activeRow({ credential_expires_at: expiresAt })]),
      );
    const readString = vi.fn().mockResolvedValue(
      credential({
        rotation: {
          mode: 'ROTATING',
          refreshToken: 'xoxe-sensitive-refresh-token',
          expiresAt: expiresAt.toISOString(),
        },
      }),
    );
    const { subject } = resolver({ query, readString });

    await expect(subject.resolve(workspaceId)).rejects.toMatchObject({
      code: 'SLACK_INSTALLATION_CREDENTIAL_EXPIRED',
      retryable: false,
    });
  });

  it('classifies database failures as retryable without exposing their message', async () => {
    const query = vi
      .fn()
      .mockRejectedValue(new Error('sensitive database connection details'));
    const { subject } = resolver({ query });

    let thrown: unknown;
    try {
      await subject.resolve(workspaceId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SlackInstallationCredentialResolutionError);
    expect(thrown).toMatchObject({
      code: 'SLACK_INSTALLATION_LOOKUP_FAILED',
      retryable: true,
      message: 'Slack installation credential could not be resolved',
    });
  });

  it('does not query PostgreSQL for a malformed workspace identifier', async () => {
    const query = vi.fn();
    const { subject } = resolver({ query });

    await expect(subject.resolve("T001' OR true")).rejects.toMatchObject({
      code: 'SLACK_INSTALLATION_NOT_FOUND',
      retryable: false,
    });
    expect(query).not.toHaveBeenCalled();
  });
});
