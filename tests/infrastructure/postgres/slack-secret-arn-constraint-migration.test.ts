import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Slack secret ARN constraint migration', () => {
  it('uses an explicit length check instead of an unsupported regex bound', async () => {
    const migration = await readFile(
      'db/migrations/0014_slack_secret_arn_constraint.sql',
      'utf8',
    );
    const forwardMigration = migration.slice(
      migration.lastIndexOf('ALTER TABLE slack_installations'),
    );

    expect(forwardMigration).toContain(
      'DROP CONSTRAINT slack_installations_secret_arn_valid',
    );
    expect(forwardMigration).toContain(
      "split_part(credential_secret_arn, ':secret:', 2)",
    );
    expect(forwardMigration).toContain('BETWEEN 1 AND 512');
    expect(forwardMigration).not.toContain('{1,512}');
    expect(forwardMigration).toMatch(
      /credential_secret_arn ~ '\^arn:\(aws\|aws-us-gov\|aws-cn\):secretsmanager:/u,
    );
  });
});
