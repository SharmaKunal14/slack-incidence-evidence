import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { describe, expect, it, vi } from 'vitest';
import {
  SecretsManagerSecretReader,
  SecretValueUnavailableError,
} from '../../../src/infrastructure/secrets/secrets-manager-secret-reader.js';

type Send = (command: unknown) => Promise<unknown>;

function createClient(send: Send): SecretsManagerClient {
  return { send } as unknown as SecretsManagerClient;
}

describe('SecretsManagerSecretReader', () => {
  it('reads a string secret and coalesces concurrent warm reads', async () => {
    const send = vi
      .fn<Send>()
      .mockResolvedValue({ SecretString: '{"key":"value"}' });
    const reader = new SecretsManagerSecretReader(createClient(send));

    await expect(
      Promise.all([
        reader.readString('secret-arn'),
        reader.readString('secret-arn'),
      ]),
    ).resolves.toEqual(['{"key":"value"}', '{"key":"value"}']);

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetSecretValueCommand);
    expect((command as GetSecretValueCommand).input).toEqual({
      SecretId: 'secret-arn',
    });
  });

  it('decodes binary secrets', async () => {
    const send = vi
      .fn<Send>()
      .mockResolvedValue({ SecretBinary: Buffer.from('binary-value', 'utf8') });
    const reader = new SecretsManagerSecretReader(createClient(send));

    await expect(reader.readString('secret-arn')).resolves.toBe('binary-value');
  });

  it('does not cache failures', async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ SecretString: 'recovered' });
    const reader = new SecretsManagerSecretReader(createClient(send));

    await expect(reader.readString('secret-arn')).rejects.toThrow('transient');
    await expect(reader.readString('secret-arn')).resolves.toBe('recovered');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty response without exposing content', async () => {
    const send = vi.fn<Send>().mockResolvedValue({});
    const reader = new SecretsManagerSecretReader(createClient(send));

    await expect(reader.readString('secret-arn')).rejects.toBeInstanceOf(
      SecretValueUnavailableError,
    );
  });
});
