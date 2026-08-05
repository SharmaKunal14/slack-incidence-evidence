import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Slack Enterprise user ID migration', () => {
  it('widens only the reviewer Slack identity constraint', async () => {
    const migration = await readFile(
      'db/migrations/0013_slack_enterprise_user_ids.sql',
      'utf8',
    );

    expect(migration).toContain(
      'DROP CONSTRAINT reviewer_memberships_slack_user_id_valid',
    );
    expect(migration).toMatch(
      /slack_user_id IS NULL OR slack_user_id ~ '\^\[UW\]/u,
    );
    expect(migration).not.toMatch(/UPDATE|DELETE|TRUNCATE/iu);
  });
});
