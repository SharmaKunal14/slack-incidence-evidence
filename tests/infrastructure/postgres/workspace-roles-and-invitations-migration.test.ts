import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('workspace roles and invitations migration', () => {
  it('keeps invitation activation identity-bound and assignments tenant-bound', async () => {
    const migration = await readFile(
      'db/migrations/0016_workspace_roles_and_invitations.sql',
      'utf8',
    );

    expect(migration).toContain(
      "role IN ('OWNER', 'ADMIN', 'REVIEWER', 'VIEWER')",
    );
    expect(migration).toContain('CREATE TABLE workspace_invitations');
    expect(migration).toContain('invited_slack_user_id');
    expect(migration).toContain('token_sha256 CHAR(64) NOT NULL UNIQUE');
    expect(migration).toContain('CREATE TABLE slack_identity_authorizations');
    expect(migration).toContain('nonce_sha256 CHAR(64) NOT NULL');
    expect(migration).toContain(
      'FOREIGN KEY (tenant_id, assigned_reviewer_subject)',
    );
    expect(migration).not.toMatch(/delivery_email\s*=\s*accepted/u);
  });
});
