import {
  CreateSecretCommand,
  PutSecretValueCommand,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { describe, expect, it, vi } from 'vitest';
import { SlackInstallationCredentialStoreError } from '../../../src/application/ports/slack-installation-credential-store.js';
import { SecretsManagerSlackInstallationCredentialStore } from '../../../src/infrastructure/secrets/secrets-manager-slack-installation-credential-store.js';

type Send = (command: unknown) => Promise<unknown>;

const authorizationId = 'b5ce083c-6f22-4c8d-87fc-d23a8d2aa92c';
const secretArn =
  'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:onrecord/slack/installations/attempt-AbCd12';
const credential = {
  schemaVersion: 1 as const,
  teamId: 'T001',
  botUserId: 'U001',
  accessToken: 'xoxe.xoxb-access',
  rotation: {
    mode: 'ROTATING' as const,
    refreshToken: 'xoxe-refresh',
    expiresAt: '2026-08-05T13:00:00.000Z',
  },
};

function createStore(
  send: Send,
): SecretsManagerSlackInstallationCredentialStore {
  const client = { send } as unknown as SecretsManagerClient;
  return new SecretsManagerSlackInstallationCredentialStore(client, {
    secretNamePrefix: 'onrecord/slack/installations',
    kmsKeyId:
      'arn:aws:kms:ap-southeast-2:123456789012:key/12345678-1234-1234-1234-123456789012',
  });
}

describe('SecretsManagerSlackInstallationCredentialStore', () => {
  it('creates an attempt-scoped KMS secret with an idempotency token', async () => {
    const send = vi.fn<Send>().mockResolvedValue({ ARN: secretArn });
    const store = createStore(send);

    await expect(store.store({ authorizationId, credential })).resolves.toEqual(
      { secretArn },
    );

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(CreateSecretCommand);
    const input = (command as CreateSecretCommand).input;
    expect(input.Name).toBe(`onrecord/slack/installations/${authorizationId}`);
    expect(input.ClientRequestToken).toBe(authorizationId);
    expect(input.KmsKeyId).toContain(':key/');
    expect(JSON.parse(input.SecretString ?? '')).toEqual(credential);
    expect(input.Tags).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ Value: credential.teamId }),
      ]),
    );
  });

  it('recovers an ambiguous create with the same version token and value', async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce({ name: 'ResourceExistsException' })
      .mockResolvedValueOnce({ ARN: secretArn });
    const store = createStore(send);

    await expect(store.store({ authorizationId, credential })).resolves.toEqual(
      { secretArn },
    );

    const command = send.mock.calls[1]?.[0];
    expect(command).toBeInstanceOf(PutSecretValueCommand);
    expect((command as PutSecretValueCommand).input).toMatchObject({
      SecretId: `onrecord/slack/installations/${authorizationId}`,
      ClientRequestToken: authorizationId,
      SecretString: JSON.stringify(credential),
      VersionStages: ['AWSCURRENT'],
    });
  });

  it('returns content-safe retryability for AWS failures', async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValue({ name: 'AccessDeniedException' });
    const store = createStore(send);

    await expect(store.store({ authorizationId, credential })).rejects.toEqual(
      new SlackInstallationCredentialStoreError(false),
    );
  });

  it('rejects a successful AWS response without a valid Secrets Manager ARN', async () => {
    const send = vi.fn<Send>().mockResolvedValue({ ARN: undefined });
    const store = createStore(send);

    await expect(
      store.store({ authorizationId, credential }),
    ).rejects.toBeInstanceOf(SlackInstallationCredentialStoreError);
  });
});
