import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { describe, expect, it, vi } from 'vitest';
import { SecretsManagerSlackInstallationCredentialLifecycle } from '../../../src/infrastructure/secrets/secrets-manager-slack-installation-credential-lifecycle.js';

type Send = (command: unknown) => Promise<unknown>;
const secretArn =
  'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:incident-copilot/development/slack/installations/attempt-AbCd12';
const credential = {
  schemaVersion: 1,
  teamId: 'T001',
  botUserId: 'U001',
  accessToken: 'xoxb-secret',
  rotation: { mode: 'LONG_LIVED' },
} as const;

function lifecycle(
  send: ReturnType<typeof vi.fn<Send>>,
): SecretsManagerSlackInstallationCredentialLifecycle {
  return new SecretsManagerSlackInstallationCredentialLifecycle(
    { send } as unknown as SecretsManagerClient,
    { recoveryWindowDays: 7 },
  );
}

describe('SecretsManagerSlackInstallationCredentialLifecycle', () => {
  it('loads and validates the tenant credential', async () => {
    const send = vi
      .fn<Send>()
      .mockResolvedValue({ SecretString: JSON.stringify(credential) });

    await expect(lifecycle(send).load(secretArn)).resolves.toEqual(credential);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetSecretValueCommand);
  });

  it('schedules recoverable deletion rather than force deletion', async () => {
    const send = vi.fn<Send>().mockResolvedValue({});

    await expect(lifecycle(send).scheduleDeletion(secretArn)).resolves.toBe(
      undefined,
    );
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(DeleteSecretCommand);
    expect((command as DeleteSecretCommand).input).toEqual({
      SecretId: secretArn,
      RecoveryWindowInDays: 7,
    });
    expect((command as DeleteSecretCommand).input).not.toHaveProperty(
      'ForceDeleteWithoutRecovery',
    );
  });

  it('treats a secret already scheduled for deletion as unavailable', async () => {
    const invalidRequest = Object.assign(new Error('scheduled'), {
      name: 'InvalidRequestException',
    });
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(invalidRequest)
      .mockResolvedValueOnce({ DeletedDate: new Date('2026-08-14T01:00:00Z') });

    await expect(lifecycle(send).load(secretArn)).resolves.toBeNull();
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DescribeSecretCommand);
  });

  it('rejects malformed credential material without exposing it', async () => {
    const send = vi
      .fn<Send>()
      .mockResolvedValue({ SecretString: '{"accessToken":"leaked"}' });

    await expect(lifecycle(send).load(secretArn)).rejects.toMatchObject({
      retryable: false,
      message: 'Slack installation credential lifecycle operation failed',
    });
  });
});
