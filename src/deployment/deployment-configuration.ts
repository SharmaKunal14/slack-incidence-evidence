import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const environmentNameSchema = z.enum(['development', 'staging', 'production']);
const accountIdSchema = z.string().regex(/^[0-9]{12}$/);
const regionSchema = z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/);
const bucketSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/)
  .refine((value) => !value.includes('..'), 'Invalid S3 bucket name');
const stateKeySchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9][A-Za-z0-9!_.*'()/+-]*$/)
  .refine(
    (value) => !value.split('/').includes('..'),
    'Terraform state key must not contain parent traversal',
  );

const deploymentEnvironmentSchema = z.object({
  DEPLOYMENT_ENVIRONMENT: environmentNameSchema,
  AWS_ACCOUNT_ID: accountIdSchema,
  AWS_REGION: regionSchema,
  AWS_DEPLOY_ROLE_ARN: z.string().min(1),
  AWS_LAMBDA_ROLE_PERMISSIONS_BOUNDARY_ARN: z.string().min(1),
  AWS_WORKFLOW_ROLE_PERMISSIONS_BOUNDARY_ARN: z.string().min(1),
  TF_STATE_BUCKET: bucketSchema,
  TF_STATE_KEY: stateKeySchema,
  TF_STATE_KMS_KEY_ARN: z.string().min(1),
  TF_INPUTS_JSON: z.string().min(2).max(65_536),
  DATABASE_SECRET_ARN: z.string().min(1),
  DATABASE_HOST: z.string().min(1).max(253),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65_535),
  DATABASE_NAME: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/),
  DATABASE_SSL: z.literal('true'),
});

const requiredTerraformInputs = [
  'slack_signing_secret_arn',
  'slack_bot_token_secret_arn',
  'database_secret_arn',
  'openai_api_secret_arn',
  'publication_provider',
  'openai_model',
  'database_host',
] as const;

const reservedTerraformInputs = new Set([
  'aws_region',
  'environment',
  'expected_aws_account_id',
  'lambda_artifact_path',
  'project_name',
  'review_web_artifact_directory',
  'lambda_role_permissions_boundary_arn',
  'workflow_role_permissions_boundary_arn',
]);

function parseTerraformInputs(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('TF_INPUTS_JSON must be valid JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new Error('TF_INPUTS_JSON must contain one JSON object');
  }
  return parsed as Record<string, unknown>;
}

function validateArn(
  value: string,
  service: string,
  region: string,
  accountId: string,
): void {
  const expression = new RegExp(
    `^arn:aws:${service}:${region}:${accountId}:[A-Za-z0-9/_+=,.@:-]+$`,
  );
  if (!expression.test(value)) {
    throw new Error(
      `${service} ARN must belong to the deployment account and region`,
    );
  }
}

export interface PreparedDeploymentPaths {
  readonly backendConfigurationPath: string;
  readonly terraformVariablesPath: string;
}

export async function prepareDeploymentConfiguration(
  projectRoot: string,
  source: NodeJS.ProcessEnv,
): Promise<PreparedDeploymentPaths> {
  const environment = deploymentEnvironmentSchema.parse(source);
  const expectedRoleArn = new RegExp(
    `^arn:aws:iam::${environment.AWS_ACCOUNT_ID}:role/[A-Za-z0-9+=,.@_/-]{1,512}$`,
  );
  if (!expectedRoleArn.test(environment.AWS_DEPLOY_ROLE_ARN)) {
    throw new Error(
      'AWS deploy role ARN must belong to the deployment account',
    );
  }
  const expectedBoundaryArn = new RegExp(
    `^arn:aws:iam::${environment.AWS_ACCOUNT_ID}:policy/[A-Za-z0-9+=,.@_/-]{1,512}$`,
  );
  if (
    !expectedBoundaryArn.test(
      environment.AWS_LAMBDA_ROLE_PERMISSIONS_BOUNDARY_ARN,
    )
  ) {
    throw new Error(
      'Lambda role permissions boundary ARN must belong to the deployment account',
    );
  }
  if (
    !expectedBoundaryArn.test(
      environment.AWS_WORKFLOW_ROLE_PERMISSIONS_BOUNDARY_ARN,
    )
  ) {
    throw new Error(
      'Workflow role permissions boundary ARN must belong to the deployment account',
    );
  }
  validateArn(
    environment.TF_STATE_KMS_KEY_ARN,
    'kms',
    environment.AWS_REGION,
    environment.AWS_ACCOUNT_ID,
  );
  validateArn(
    environment.DATABASE_SECRET_ARN,
    'secretsmanager',
    environment.AWS_REGION,
    environment.AWS_ACCOUNT_ID,
  );

  const terraformInputs = parseTerraformInputs(environment.TF_INPUTS_JSON);
  const variablesFile = await readFile(
    resolve(projectRoot, 'infrastructure/terraform/variables.tf'),
    'utf8',
  );
  const declaredVariables = new Set(
    [...variablesFile.matchAll(/^variable "(?<name>[a-z0-9_]+)" \{/gmu)].map(
      (match) => match.groups?.['name'],
    ),
  );
  for (const key of Object.keys(terraformInputs)) {
    if (!declaredVariables.has(key)) {
      throw new Error(`Unknown Terraform input: ${key}`);
    }
    if (reservedTerraformInputs.has(key)) {
      throw new Error(`Terraform input is controlled by the pipeline: ${key}`);
    }
  }
  for (const key of requiredTerraformInputs) {
    if (!(key in terraformInputs)) {
      throw new Error(`Missing required Terraform input: ${key}`);
    }
  }

  for (const key of [
    'slack_signing_secret_arn',
    'slack_bot_token_secret_arn',
    'database_secret_arn',
    'review_database_secret_arn',
    'openai_api_secret_arn',
    'notion_api_secret_arn',
    'confluence_api_secret_arn',
    'publication_database_secret_arn',
  ]) {
    const value = terraformInputs[key];
    if (value !== undefined) {
      if (typeof value !== 'string') {
        throw new Error(`Terraform input ${key} must be a Secrets Manager ARN`);
      }
      validateArn(
        value,
        'secretsmanager',
        environment.AWS_REGION,
        environment.AWS_ACCOUNT_ID,
      );
    }
  }

  const publicationProvider = terraformInputs['publication_provider'];
  if (publicationProvider === 'NOTION') {
    for (const key of ['notion_api_secret_arn', 'notion_data_source_id']) {
      if (!(key in terraformInputs)) {
        throw new Error(`NOTION publication requires Terraform input: ${key}`);
      }
    }
  } else if (publicationProvider === 'CONFLUENCE') {
    for (const key of [
      'confluence_api_secret_arn',
      'confluence_base_url',
      'confluence_space_id',
    ]) {
      if (!(key in terraformInputs)) {
        throw new Error(
          `CONFLUENCE publication requires Terraform input: ${key}`,
        );
      }
    }
  } else {
    throw new Error('publication_provider must be NOTION or CONFLUENCE');
  }

  const artifactsDirectory = resolve(projectRoot, 'artifacts');
  const backendConfigurationPath = resolve(
    artifactsDirectory,
    'terraform-backend.hcl',
  );
  const terraformVariablesPath = resolve(
    artifactsDirectory,
    'deployment.auto.tfvars.json',
  );
  const backendConfiguration = [
    `bucket       = ${JSON.stringify(environment.TF_STATE_BUCKET)}`,
    `key          = ${JSON.stringify(environment.TF_STATE_KEY)}`,
    `region       = ${JSON.stringify(environment.AWS_REGION)}`,
    'encrypt      = true',
    'use_lockfile = true',
    `kms_key_id   = ${JSON.stringify(environment.TF_STATE_KMS_KEY_ARN)}`,
    '',
  ].join('\n');
  await writeFile(backendConfigurationPath, backendConfiguration, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await writeFile(
    terraformVariablesPath,
    `${JSON.stringify(
      {
        ...terraformInputs,
        aws_region: environment.AWS_REGION,
        environment: environment.DEPLOYMENT_ENVIRONMENT,
        expected_aws_account_id: environment.AWS_ACCOUNT_ID,
        project_name: 'incident-copilot',
        lambda_role_permissions_boundary_arn:
          environment.AWS_LAMBDA_ROLE_PERMISSIONS_BOUNDARY_ARN,
        workflow_role_permissions_boundary_arn:
          environment.AWS_WORKFLOW_ROLE_PERMISSIONS_BOUNDARY_ARN,
        lambda_artifact_path: '../../artifacts/incident-copilot-lambda.zip',
        review_web_artifact_directory: '../../artifacts/review-web',
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return { backendConfigurationPath, terraformVariablesPath };
}
