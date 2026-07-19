import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareDeploymentConfiguration } from '../../src/deployment/deployment-configuration.js';

const temporaryDirectories: string[] = [];
const accountId = '123456789012';
const region = 'ap-southeast-2';

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'incident-deployment-test-'));
  temporaryDirectories.push(root);
  await mkdir(resolve(root, 'infrastructure/terraform'), { recursive: true });
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  await writeFile(
    resolve(root, 'infrastructure/terraform/variables.tf'),
    [
      'aws_region',
      'environment',
      'expected_aws_account_id',
      'lambda_artifact_path',
      'project_name',
      'review_web_artifact_directory',
      'lambda_role_permissions_boundary_arn',
      'workflow_role_permissions_boundary_arn',
      'slack_signing_secret_arn',
      'slack_bot_token_secret_arn',
      'database_secret_arn',
      'openai_api_secret_arn',
      'publication_provider',
      'confluence_api_secret_arn',
      'confluence_base_url',
      'confluence_space_id',
      'openai_model',
      'database_host',
    ]
      .map((name) => `variable "${name}" {}`)
      .join('\n'),
  );
  return root;
}

function secretArn(name: string): string {
  return `arn:aws:secretsmanager:${region}:${accountId}:secret:${name}-AbCdEf`;
}

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    DEPLOYMENT_ENVIRONMENT: 'development',
    AWS_ACCOUNT_ID: accountId,
    AWS_REGION: region,
    AWS_DEPLOY_ROLE_ARN: `arn:aws:iam::${accountId}:role/github-development`,
    AWS_LAMBDA_ROLE_PERMISSIONS_BOUNDARY_ARN: `arn:aws:iam::${accountId}:policy/incident-copilot-development-lambda-boundary`,
    AWS_WORKFLOW_ROLE_PERMISSIONS_BOUNDARY_ARN: `arn:aws:iam::${accountId}:policy/incident-copilot-development-workflow-boundary`,
    TF_STATE_BUCKET: 'incident-copilot-state-123456789012',
    TF_STATE_KEY: 'incident-copilot/development/terraform.tfstate',
    TF_STATE_KMS_KEY_ARN: `arn:aws:kms:${region}:${accountId}:key/11111111-2222-3333-4444-555555555555`,
    DATABASE_SECRET_ARN: secretArn('migration-database'),
    DATABASE_HOST: 'session.pooler.example.test',
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'postgres',
    DATABASE_SSL: 'true',
    TF_INPUTS_JSON: JSON.stringify({
      slack_signing_secret_arn: secretArn('slack-signing'),
      slack_bot_token_secret_arn: secretArn('slack-bot'),
      database_secret_arn: secretArn('database'),
      openai_api_secret_arn: secretArn('openai'),
      publication_provider: 'CONFLUENCE',
      confluence_api_secret_arn: secretArn('confluence'),
      confluence_base_url: 'https://example.atlassian.net',
      confluence_space_id: '12345',
      openai_model: 'approved-model',
      database_host: 'pooler.example.test',
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('deployment configuration', () => {
  it('writes locked backend and environment-bound Terraform inputs', async () => {
    const root = await projectFixture();
    const paths = await prepareDeploymentConfiguration(
      root,
      validEnvironment(),
    );
    const backend = await readFile(paths.backendConfigurationPath, 'utf8');
    const variables = JSON.parse(
      await readFile(paths.terraformVariablesPath, 'utf8'),
    ) as Record<string, unknown>;

    expect(backend).toContain('use_lockfile = true');
    expect(backend).toContain('encrypt      = true');
    expect(variables).toMatchObject({
      environment: 'development',
      expected_aws_account_id: accountId,
      project_name: 'incident-copilot',
      lambda_role_permissions_boundary_arn: `arn:aws:iam::${accountId}:policy/incident-copilot-development-lambda-boundary`,
      workflow_role_permissions_boundary_arn: `arn:aws:iam::${accountId}:policy/incident-copilot-development-workflow-boundary`,
      lambda_artifact_path: '../../artifacts/incident-copilot-lambda.zip',
    });
  });

  it('rejects environment attempts to override pipeline-controlled inputs', async () => {
    const root = await projectFixture();
    const source = validEnvironment();
    source.TF_INPUTS_JSON = JSON.stringify({
      ...JSON.parse(source.TF_INPUTS_JSON ?? '{}'),
      environment: 'production',
    });

    await expect(prepareDeploymentConfiguration(root, source)).rejects.toThrow(
      'controlled by the pipeline',
    );
  });

  it('rejects cross-account secrets and deployment roles', async () => {
    const root = await projectFixture();
    const roleSource = validEnvironment();
    roleSource.AWS_DEPLOY_ROLE_ARN =
      'arn:aws:iam::999999999999:role/github-development';
    await expect(
      prepareDeploymentConfiguration(root, roleSource),
    ).rejects.toThrow('deployment account');

    const boundarySource = validEnvironment();
    boundarySource.AWS_LAMBDA_ROLE_PERMISSIONS_BOUNDARY_ARN =
      'arn:aws:iam::999999999999:policy/incident-copilot-development-lambda-boundary';
    await expect(
      prepareDeploymentConfiguration(root, boundarySource),
    ).rejects.toThrow('deployment account');

    const secretSource = validEnvironment();
    secretSource.TF_INPUTS_JSON = JSON.stringify({
      ...JSON.parse(secretSource.TF_INPUTS_JSON ?? '{}'),
      database_secret_arn:
        'arn:aws:secretsmanager:ap-southeast-2:999999999999:secret:database-AbCdEf',
    });
    await expect(
      prepareDeploymentConfiguration(root, secretSource),
    ).rejects.toThrow('deployment account and region');

    const migrationSource = validEnvironment();
    migrationSource.DATABASE_SECRET_ARN =
      'arn:aws:secretsmanager:ap-southeast-2:999999999999:secret:database-AbCdEf';
    await expect(
      prepareDeploymentConfiguration(root, migrationSource),
    ).rejects.toThrow('deployment account and region');
  });
});
