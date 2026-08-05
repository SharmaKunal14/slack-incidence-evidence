import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Slack OAuth onboarding migration', () => {
  it('stores only hashed authorization bindings and secret references', async () => {
    const migration = await readFile(
      'db/migrations/0012_slack_oauth_onboarding.sql',
      'utf8',
    );
    const authorizationTable =
      /CREATE TABLE slack_oauth_authorizations[\s\S]+?\n\);/u.exec(
        migration,
      )?.[0];

    expect(migration).toContain('state_sha256 CHAR(64)');
    expect(migration).toContain('browser_binding_sha256 CHAR(64)');
    expect(migration).toContain('credential_secret_arn TEXT');
    expect(migration).toContain(
      "ADD COLUMN status TEXT NOT NULL DEFAULT 'RECONNECT_REQUIRED'",
    );
    expect(authorizationTable).not.toMatch(/access_token|refresh_token/iu);
  });

  it('enforces one Slack identity per tenant and fail-closed active credentials', async () => {
    const migration = await readFile(
      'db/migrations/0012_slack_oauth_onboarding.sql',
      'utf8',
    );

    expect(migration).toContain(
      'CREATE UNIQUE INDEX reviewer_memberships_tenant_slack_user_unique',
    );
    expect(migration).toMatch(
      /status <> 'ACTIVE' OR credential_secret_arn IS NOT NULL/u,
    );
    expect(migration).toMatch(
      /status IN \('PENDING', 'CONSUMED', 'COMPLETED', 'FAILED'\)/u,
    );
    expect(migration).toContain("created_at + INTERVAL '10 minutes'");
    expect(migration).toContain('cardinality(requested_scopes) = 6');
  });
});
