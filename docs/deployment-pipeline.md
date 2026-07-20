# AWS deployment pipeline

Status: implemented workflow; AWS and GitHub environment bootstrap remains an
operator responsibility

## Release behavior

The `CI` workflow is the only automatic release path:

1. Pull requests do not run this workflow; it starts once when a commit reaches
   `main`.
2. The `main` run performs application checks and offline Terraform validation,
   then creates one digest-bound release.
3. Development deploys automatically after all verification jobs pass.
4. Staging deploys the same release only when the repository variable
   `ENABLE_STAGING_DEPLOYMENT` is exactly `true`.
5. Production deploys the same release only when both staging succeeds and the
   repository variable `ENABLE_PRODUCTION_DEPLOYMENT` is exactly `true`.

Keep both enable variables absent or `false` until their target environments
exist. This prevents GitHub from implicitly creating an unprotected environment
and attempting a deployment with incomplete configuration.

Every deployment is serialized by environment. An in-progress Terraform apply
is never cancelled. Migration or smoke-test failure stops promotion.

## GitHub Environments

Create GitHub Environments named exactly:

- `development`
- `staging`
- `production`

Restrict all three to the protected `main` branch. Configure production with a
required reviewer, prevent self-review, and disable administrator bypass where
the repository plan supports those controls. Workflow YAML can select an
environment but cannot create or enforce its protection rules.

Each environment requires these GitHub **variables**:

| Variable                                     | Purpose                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `AWS_ACCOUNT_ID`                             | Exact 12-digit account permitted by both OIDC and Terraform.                     |
| `AWS_REGION`                                 | Deployment and state region, currently `ap-southeast-2`.                         |
| `AWS_DEPLOY_ROLE_ARN`                        | Environment-specific OIDC role ARN.                                              |
| `AWS_LAMBDA_ROLE_PERMISSIONS_BOUNDARY_ARN`   | Boundary required on every Terraform-created Lambda IAM role.                    |
| `AWS_WORKFLOW_ROLE_PERMISSIONS_BOUNDARY_ARN` | Boundary required on the Terraform-created Step Functions IAM role.              |
| `TF_STATE_BUCKET`                            | Existing encrypted and versioned Terraform state bucket.                         |
| `TF_STATE_KEY`                               | Unique state path, for example `incident-copilot/development/terraform.tfstate`. |
| `TF_STATE_KMS_KEY_ARN`                       | Customer-managed KMS key for state and lock objects.                             |
| `TF_INPUTS_JSON`                             | Non-secret Terraform inputs described below.                                     |
| `MIGRATION_DATABASE_SECRET_ARN`              | Secrets Manager ARN for the migration database user.                             |
| `MIGRATION_DATABASE_HOST`                    | Session-capable PostgreSQL endpoint.                                             |
| `MIGRATION_DATABASE_PORT`                    | Session endpoint port, normally `5432` for Supabase.                             |
| `MIGRATION_DATABASE_NAME`                    | PostgreSQL database name.                                                        |

Do not store passwords, tokens, signing secrets, private keys, CA private keys,
connection strings, or secret JSON values in GitHub. Secret ARNs are identifiers
and belong in `TF_INPUTS_JSON`; values remain in AWS Secrets Manager.

### Terraform input JSON

`TF_INPUTS_JSON` is validated against the root's declared variables. The
pipeline rejects unknown keys and does not allow operators to override the AWS
region, account, environment, or artifact paths.

Minimal Confluence example:

```json
{
  "slack_signing_secret_arn": "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:incident-copilot/development/slack-signing-AbCdEf",
  "slack_bot_token_secret_arn": "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:incident-copilot/development/slack-bot-AbCdEf",
  "database_secret_arn": "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:incident-copilot/development/database-AbCdEf",
  "openai_api_secret_arn": "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:incident-copilot/development/openai-AbCdEf",
  "publication_provider": "CONFLUENCE",
  "confluence_api_secret_arn": "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:incident-copilot/development/confluence-AbCdEf",
  "confluence_base_url": "https://example.atlassian.net",
  "confluence_cloud_id": "replace-with-cloud-id",
  "confluence_space_id": "123456789",
  "openai_model": "replace-with-reviewed-model-snapshot",
  "database_host": "aws-0-ap-southeast-2.pooler.supabase.com",
  "database_port": 6543,
  "database_name": "postgres",
  "evidence_retention_days": 30,
  "additional_tags": {
    "Owner": "platform-engineering",
    "Repository": "slack-rca"
  }
}
```

All Secrets Manager ARNs must belong to the configured deployment account and
region. Staging and production must use distinct Slack apps, databases, secret
objects, Cognito users, and publication destinations. Resource-name prefixes
and separate state alone do not isolate external data.

## AWS OIDC trust

Create the GitHub OIDC provider once per AWS account with issuer
`https://token.actions.githubusercontent.com` and audience
`sts.amazonaws.com`. Use a separate role for each environment. A development
role trust condition is structurally:

```json
{
  "Effect": "Allow",
  "Principal": {
    "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID:environment:development"
    }
  }
}
```

The owner and repository IDs are part of this repository's current immutable
GitHub OIDC subject. Resolve the effective `sub_claim_prefix` through GitHub's
OIDC configuration API during bootstrap; do not infer it from repository names.

Replace the account and environment for other targets. Do not use a wildcard
repository or subject. Because an environment subject does not also encode the
branch, the GitHub Environment's deployment-branch restriction is part of the
authorization boundary.

Create the role and its mandatory runtime-role permissions boundary with the
version-controlled bootstrap stack in
`infrastructure/bootstrap/deployment-role.json`. The CloudShell procedure and
cutover commands are in `infrastructure/bootstrap/README.md`. Do not assemble
the Terraform provisioning policy incrementally from access-denied failures.

The deployment role needs:

- read/write/delete access only to its state object and `.tflock` object;
- `s3:ListBucket` limited to its state prefix;
- KMS encrypt/decrypt/data-key access only on the state key;
- `secretsmanager:GetSecretValue` only on the migration database secret;
- any required `kms:Decrypt` only on that secret's customer-managed key;
- Terraform permissions for resources bearing the environment's
  `incident-copilot-<environment>` prefix; and
- read-only Lambda configuration calls used by the smoke test; and
- CloudFront invalidation creation and status reads for the one environment
  distribution.

API Gateway, CloudFront, Cognito, and some IAM creation APIs cannot be fully
resource-scoped before their generated identifiers exist. Any unavoidable
wildcard must be limited by action, account, region where supported, OIDC
subject, and the environment-specific role. Do not attach `AdministratorAccess`.

## Remote state bootstrap

The state bucket must have:

- public access blocked;
- bucket-owner-enforced object ownership;
- versioning enabled;
- default SSE-KMS encryption using `TF_STATE_KMS_KEY_ARN`;
- a policy denying non-TLS requests;
- no lifecycle rule that expires current state or lock objects; and
- recovery access held outside the normal deployment role.

The deployment-role bootstrap stack consumes the existing state bucket, state
key, state KMS key, and migration secret as parameters. It deliberately does
not own them, so a stack update cannot delete or replace Terraform state.

The pipeline enables native S3 lockfiles with `use_lockfile = true`. It does not
use the deprecated DynamoDB locking path.

If development currently uses local state, do not start CI against an empty
remote key. First back up the local state, verify the target account, and run an
operator-reviewed `terraform init -migrate-state` using the same backend
configuration. An empty remote state against existing resources can produce a
destructive or conflicting plan.

## Deployment gates

For each environment the reusable workflow:

1. downloads the release built by the same `main` workflow;
2. recomputes Lambda, web, and migration hashes;
3. validates account, role, state, KMS, and Terraform configuration;
4. obtains short-lived AWS credentials through OIDC;
5. creates a saved Terraform plan;
6. rejects every delete or replacement action;
7. applies checksum-protected migrations through the session endpoint;
8. applies the exact saved plan; and
9. invalidates CloudFront and verifies all Lambda and frontend artifact hashes,
   rejection of an invalid Slack signature, review API authentication, and
   CloudFront availability.

The smoke test is deterministic and does not consume OpenAI quota. A scheduled
staging synthetic incident that exercises Slack collection and AI generation is
still required before enabling unattended staging-to-production promotion.

## Failure and rollback

- A failed check, plan, migration, apply, or smoke test blocks the next environment.
- SQL migrations are forward-only and are never automatically rolled back.
- Terraform plan files remain on the ephemeral runner and are not uploaded;
  they can contain sensitive values even when console output redacts them.
- Ordinary releases cannot delete or replace Terraform resources.
- GitHub retains the build artifact for 90 days. Long-term release storage and
  a digest-selected rollback workflow are still required before production is
  enabled.
- If `terraform apply` partially succeeds, rerun or repair the same release;
  do not restore an older state file over successfully changed infrastructure.
- After an IAM-denied partial apply, inspect the same remote state, deploy or
  update the bootstrap stack, switch the GitHub Environment to its role and
  boundary outputs, and rerun. Do not delete partially created resources.

## Environment activation order

1. Bootstrap development state, KMS, OIDC role, and GitHub Environment variables.
2. Reapply the checked-in review and publication database grant scripts so
   least-privilege roles can read `schema_migrations` during startup.
3. Migrate any existing development Terraform state.
4. Merge a no-op change and verify the automatic development deployment.
5. Create isolated staging dependencies and protection rules.
6. Set `ENABLE_STAGING_DEPLOYMENT=true` and verify promotion.
7. Add the live staging synthetic and rollback workflow.
8. Create the isolated production account/dependencies and required reviewer.
9. Set `ENABLE_PRODUCTION_DEPLOYMENT=true` only after the earlier gates pass.
