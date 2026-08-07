import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const runtimeCompositionRoots = [
  'src/lambda/slack-ingress-main.ts',
  'src/lambda/incident-worker-main.ts',
  'src/lambda/slack-evidence-collector-main.ts',
  'src/lambda/incident-analysis-main.ts',
  'src/lambda/incident-review-notification-main.ts',
  'src/lambda/approved-report-publication-main.ts',
] as const;

describe('Slack runtime credential routing', () => {
  it('resolves OAuth installation credentials in every Slack runtime', async () => {
    const sources = await Promise.all(
      runtimeCompositionRoots.map(readFileUtf8),
    );

    for (const source of sources) {
      expect(source).toContain(
        'PostgresSecretsSlackInstallationCredentialResolver',
      );
      expect(source).not.toContain('SLACK_BOT_TOKEN_SECRET_ARN');
      expect(source).not.toContain('parseSlackBotTokenSecret');
    }
  });

  it('scopes runtime IAM to the installation prefix and installation KMS key', async () => {
    const terraform = await readFileUtf8('infrastructure/terraform/main.tf');

    expect(terraform).not.toContain('var.slack_bot_token_secret_arn');
    expect(
      terraform.match(/sid\s+= "ReadWorkspaceSlackCredentials"/gu),
    ).toHaveLength(runtimeCompositionRoots.length);
    expect(
      terraform.match(/sid\s+= "DecryptWorkspaceSlackCredentials"/gu),
    ).toHaveLength(runtimeCompositionRoots.length);
    expect(
      terraform.match(
        /sid\s+= "ReadWorkspaceSlackCredentials"[\s\S]*?resources = \[local\.slack_installation_secret_arn_pattern\]/gu,
      ),
    ).toHaveLength(runtimeCompositionRoots.length);
    expect(
      terraform.match(
        /sid\s+= "DecryptWorkspaceSlackCredentials"[\s\S]*?resources = \[var\.slack_installation_kms_key_arn\]/gu,
      ),
    ).toHaveLength(runtimeCompositionRoots.length);
  });

  it('gives ingress a production-required read-only database credential path', async () => {
    const [terraform, variables, grants] = await Promise.all([
      readFileUtf8('infrastructure/terraform/main.tf'),
      readFileUtf8('infrastructure/terraform/variables.tf'),
      readFileUtf8('db/security/slack_runtime_credential_grants.sql'),
    ]);

    expect(terraform).toContain(
      'DATABASE_SECRET_ARN                 = local.slack_runtime_database_secret',
    );
    expect(terraform).toContain(
      'var.environment != "production" || var.slack_runtime_database_secret_arn != null',
    );
    expect(variables).toContain('variable "slack_runtime_database_secret_arn"');
    expect(grants).toMatch(
      /GRANT SELECT ON TABLE\s+public\.schema_migrations,\s+slack_installations/u,
    );
    expect(grants).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE)/u);
  });
});

function readFileUtf8(path: string): Promise<string> {
  return readFile(path, 'utf8');
}
