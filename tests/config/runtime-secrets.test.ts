import { describe, expect, it } from 'vitest';
import {
  InvalidRuntimeSecretError,
  parseDatabaseCredentials,
  parseSlackSigningSecret,
} from '../../src/config/runtime-secrets.js';

describe('runtime secret contracts', () => {
  it('parses the two least-privilege secret shapes', () => {
    expect(
      parseSlackSigningSecret(
        JSON.stringify({ signingSecret: 'slack-secret' }),
      ),
    ).toEqual({ signingSecret: 'slack-secret' });
    expect(
      parseDatabaseCredentials(
        JSON.stringify({ username: 'worker', password: 'database-secret' }),
      ),
    ).toEqual({ username: 'worker', password: 'database-secret' });
  });

  it('rejects unexpected fields to catch a miswired secret', () => {
    expect(() =>
      parseSlackSigningSecret(
        JSON.stringify({ signingSecret: 'value', databasePassword: 'wrong' }),
      ),
    ).toThrow();
  });

  it('does not echo malformed secret content in JSON errors', () => {
    const sensitiveValue = 'do-not-expose-this';
    let error: unknown;
    try {
      parseDatabaseCredentials(`{${sensitiveValue}`);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InvalidRuntimeSecretError);
    expect(String(error)).not.toContain(sensitiveValue);
  });
});
