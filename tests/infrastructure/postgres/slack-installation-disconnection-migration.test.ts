import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Slack installation disconnection migration', () => {
  it('adds a fail-closed lifecycle state without changing credential storage', async () => {
    const migration = await readFile(
      'db/migrations/0015_slack_installation_disconnection.sql',
      'utf8',
    );

    expect(migration).toContain("'DISCONNECTING'");
    expect(migration).toContain(
      'DROP CONSTRAINT slack_installations_status_valid',
    );
    expect(migration).not.toContain('credential_secret_arn TEXT');
  });
});
