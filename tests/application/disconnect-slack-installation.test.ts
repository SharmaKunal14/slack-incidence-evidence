import { describe, expect, it, vi } from 'vitest';
import {
  DisconnectSlackInstallation,
  type SlackInstallationDisconnectionError,
} from '../../src/application/onboarding/disconnect-slack-installation.js';
import { SlackAppUninstallError } from '../../src/application/ports/slack-app-uninstaller.js';
import { SlackInstallationDisconnectionRepositoryError } from '../../src/application/ports/slack-installation-disconnection-repository.js';

const now = new Date('2026-08-07T01:00:00.000Z');
const secretArn =
  'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:incident-copilot/development/slack/installations/attempt-AbCd12';
const claim = {
  installationId: 'slack-installation:1',
  tenantId: 'T001',
  workspaceId: 'T001',
  credentialSecretArn: secretArn,
  state: 'CLAIMED' as const,
};

function dependencies(
  overrides: {
    readonly begin?: ReturnType<typeof vi.fn>;
    readonly load?: ReturnType<typeof vi.fn>;
    readonly uninstall?: ReturnType<typeof vi.fn>;
    readonly scheduleDeletion?: ReturnType<typeof vi.fn>;
  } = {},
): {
  readonly service: DisconnectSlackInstallation;
  readonly begin: ReturnType<typeof vi.fn>;
  readonly complete: ReturnType<typeof vi.fn>;
  readonly recordFailure: ReturnType<typeof vi.fn>;
  readonly load: ReturnType<typeof vi.fn>;
  readonly uninstall: ReturnType<typeof vi.fn>;
  readonly scheduleDeletion: ReturnType<typeof vi.fn>;
} {
  const begin = overrides.begin ?? vi.fn().mockResolvedValue(claim);
  const complete = vi.fn().mockResolvedValue({ idempotent: false });
  const recordFailure = vi.fn().mockResolvedValue(undefined);
  const load =
    overrides.load ??
    vi.fn().mockResolvedValue({
      schemaVersion: 1,
      teamId: 'T001',
      botUserId: 'U001',
      accessToken: 'xoxb-secret',
      rotation: { mode: 'LONG_LIVED' },
    });
  const uninstall =
    overrides.uninstall ?? vi.fn().mockResolvedValue('UNINSTALLED');
  const scheduleDeletion =
    overrides.scheduleDeletion ?? vi.fn().mockResolvedValue(undefined);
  const ids = [
    '0e83264c-6eb7-4c4d-97f2-c36caa8df167',
    '61e9f284-68e1-42a8-baf7-b31d0df8cf80',
    'e45449dd-e23d-42bb-bfe2-7938099fec8a',
  ];
  return {
    service: new DisconnectSlackInstallation(
      { begin, complete, recordFailure },
      { load, scheduleDeletion },
      { uninstall },
      { now: () => now },
      { generate: () => ids.shift() ?? ids[0]! },
    ),
    begin,
    complete,
    recordFailure,
    load,
    uninstall,
    scheduleDeletion,
  };
}

const input = {
  workspaceId: 'T001',
  cognitoSubject: '9f218e92-36a8-455d-869c-a76e27b399df',
  requestId: 'request-id',
};

describe('DisconnectSlackInstallation', () => {
  it('uninstalls Slack, schedules recoverable deletion, and finalizes the database', async () => {
    const deps = dependencies();

    await expect(deps.service.execute(input)).resolves.toEqual({
      workspaceId: 'T001',
      status: 'DISCONNECTED',
      idempotent: false,
    });

    expect(deps.uninstall).toHaveBeenCalledWith('xoxb-secret');
    expect(deps.scheduleDeletion).toHaveBeenCalledWith(secretArn);
    expect(deps.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        slackUninstallOutcome: 'UNINSTALLED',
        secretDeletionScheduled: true,
      }),
    );
  });

  it('returns an already-clean disconnection without external calls', async () => {
    const deps = dependencies({
      begin: vi.fn().mockResolvedValue({
        ...claim,
        credentialSecretArn: null,
        state: 'ALREADY_DISCONNECTED',
      }),
    });

    await expect(deps.service.execute(input)).resolves.toMatchObject({
      status: 'DISCONNECTED',
      idempotent: true,
    });
    expect(deps.load).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('records a retryable provider failure while leaving cleanup resumable', async () => {
    const deps = dependencies({
      uninstall: vi.fn().mockRejectedValue(new SlackAppUninstallError(true)),
    });

    await expect(deps.service.execute(input)).rejects.toMatchObject({
      code: 'SLACK_APP_UNINSTALL_FAILED',
      retryable: true,
    });
    expect(deps.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: 'SLACK_APP_UNINSTALL_FAILED',
        retryable: true,
      }),
    );
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('fails closed and completes when the credential is already unavailable', async () => {
    const deps = dependencies({ load: vi.fn().mockResolvedValue(null) });

    await expect(deps.service.execute(input)).resolves.toMatchObject({
      status: 'DISCONNECTED',
    });
    expect(deps.uninstall).not.toHaveBeenCalled();
    expect(deps.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        slackUninstallOutcome: 'CREDENTIAL_UNAVAILABLE',
        secretDeletionScheduled: false,
      }),
    );
  });

  it('never uninstalls with a credential belonging to another workspace', async () => {
    const deps = dependencies({
      load: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        teamId: 'T999',
        botUserId: 'U001',
        accessToken: 'xoxb-wrong-workspace',
        rotation: { mode: 'LONG_LIVED' },
      }),
    });

    await expect(deps.service.execute(input)).rejects.toMatchObject({
      code: 'SLACK_INSTALLATION_CREDENTIAL_INVALID',
      retryable: false,
    });
    expect(deps.uninstall).not.toHaveBeenCalled();
    expect(deps.scheduleDeletion).not.toHaveBeenCalled();
  });

  it('maps database authorization denial without running external effects', async () => {
    const deps = dependencies({
      begin: vi
        .fn()
        .mockRejectedValue(
          new SlackInstallationDisconnectionRepositoryError('ADMIN_REQUIRED'),
        ),
    });

    await expect(deps.service.execute(input)).rejects.toEqual(
      expect.objectContaining<Partial<SlackInstallationDisconnectionError>>({
        code: 'SLACK_INSTALLATION_ADMIN_REQUIRED',
        retryable: false,
      }),
    );
    expect(deps.load).not.toHaveBeenCalled();
  });
});
