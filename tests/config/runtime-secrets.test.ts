import { describe, expect, it } from 'vitest';
import {
  InvalidRuntimeSecretError,
  parseDatabaseConnectionSecret,
  parseSlackBotTokenSecret,
  parseSlackSigningSecret,
} from '../../src/config/runtime-secrets.js';

const databaseCa = [
  '-----BEGIN CERTIFICATE-----',
  'dGVzdC1jZXJ0aWZpY2F0ZQ==',
  '-----END CERTIFICATE-----',
].join('\n');

describe('runtime secret contracts', () => {
  it('parses the least-privilege secret shapes', () => {
    expect(
      parseSlackSigningSecret(
        JSON.stringify({ signingSecret: 'slack-secret' }),
      ),
    ).toEqual({ signingSecret: 'slack-secret' });
    expect(
      parseSlackBotTokenSecret(
        JSON.stringify({ workspaceId: 'T001', botToken: 'xoxb-secret' }),
      ),
    ).toEqual({ workspaceId: 'T001', botToken: 'xoxb-secret' });
    expect(
      parseDatabaseConnectionSecret(
        JSON.stringify({
          username: 'worker',
          password: 'database-secret',
          caCertificate: databaseCa,
        }),
      ),
    ).toEqual({
      username: 'worker',
      password: 'database-secret',
      caCertificate: databaseCa,
    });
  });

  it('rejects unexpected fields to catch a miswired secret', () => {
    expect(() =>
      parseSlackSigningSecret(
        JSON.stringify({ signingSecret: 'value', databasePassword: 'wrong' }),
      ),
    ).toThrow();

    expect(() =>
      parseSlackBotTokenSecret(
        JSON.stringify({
          workspaceId: 'T001',
          botToken: 'xoxb-secret',
          signingSecret: 'wrong-boundary',
        }),
      ),
    ).toThrow(InvalidRuntimeSecretError);
  });

  it('does not echo malformed secret content in JSON errors', () => {
    const sensitiveValue = 'do-not-expose-this';
    let error: unknown;
    try {
      parseDatabaseConnectionSecret(`{${sensitiveValue}`);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InvalidRuntimeSecretError);
    expect(String(error)).not.toContain(sensitiveValue);
  });

  it('rejects a database secret without a PEM CA certificate', () => {
    expect(() =>
      parseDatabaseConnectionSecret(
        JSON.stringify({
          username: 'worker',
          password: 'database-secret',
        }),
      ),
    ).toThrow(InvalidRuntimeSecretError);

    expect(() =>
      parseDatabaseConnectionSecret(
        JSON.stringify({
          username: 'worker',
          password: 'database-secret',
          caCertificate: 'not-a-certificate',
        }),
      ),
    ).toThrow(InvalidRuntimeSecretError);
  });
});
