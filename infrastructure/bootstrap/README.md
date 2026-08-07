# AWS deployment-role bootstrap

This stack is the trust root for the application Terraform deployment. It is
intentionally separate from `infrastructure/terraform`: a role cannot safely
grant itself the permissions and boundary needed to create its own runtime IAM
roles.

The stack creates:

- one GitHub OIDC role for exactly one GitHub Environment subject;
- five environment-scoped deployment policies plus an optional migration KMS
  policy; and
- separate mandatory permissions boundaries for the Lambda roles and the Step
  Functions role created by the application Terraform root.

It does not create or modify the remote-state bucket, state KMS key, GitHub OIDC
provider, database secret, or application resources. Those resources are
validated as existing inputs.

## CloudShell deployment

Run these commands from the repository root in AWS CloudShell. Use the same AWS
account and region as the failed deployment.

```bash
export AWS_REGION=ap-southeast-2
export AWS_DEFAULT_REGION="$AWS_REGION"

AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
TF_STATE_BUCKET="incident-copilot-tfstate-${AWS_ACCOUNT_ID}-${AWS_REGION}"
TF_STATE_KEY="incident-copilot/development/application.tfstate"
TF_STATE_KMS_KEY_ARN="$(
  aws kms describe-key \
    --key-id alias/incident-copilot-development-terraform-state \
    --query KeyMetadata.Arn \
    --output text
)"
MIGRATION_SECRET_ARN="$(
  aws secretsmanager describe-secret \
    --secret-id incident-copilot/development/database \
    --query ARN \
    --output text
)"
```

Check whether the migration secret uses a customer-managed KMS key:

```bash
aws secretsmanager describe-secret \
  --secret-id "$MIGRATION_SECRET_ARN" \
  --query KmsKeyId \
  --output text
```

An output of `None` means omit `--migration-secret-kms-key-arn`. Otherwise,
resolve the returned key ID or alias to its key ARN and supply it.

Deploy the bootstrap stack:

```bash
./infrastructure/bootstrap/deploy.sh \
  --environment development \
  --github-repository 'SharmaKunal14/slack-incidence-evidence' \
  --state-bucket "$TF_STATE_BUCKET" \
  --state-key "$TF_STATE_KEY" \
  --state-kms-key-arn "$TF_STATE_KMS_KEY_ARN" \
  --migration-secret-arn "$MIGRATION_SECRET_ARN"
```

Rerun this same command after pulling onboarding lifecycle changes.
CloudFormation updates the existing Lambda permissions boundary in place so
only the callback role can create tagged secrets under
`incident-copilot/<environment>/slack/installations/`, while the dedicated
disconnect role may describe and schedule deletion only under that same prefix.
Terraform cannot safely update this CloudFormation-owned boundary itself. The
update also grants the
GitHub deployment role the CloudWatch Logs delivery APIs AWS requires whenever
API Gateway creates or updates HTTP API access-log settings. Those delivery APIs
do not support resource-level IAM permissions; log-group creation and log reads
remain restricted to this application's environment-scoped groups.

The script asks GitHub for the repository's current OIDC `sub_claim_prefix`,
validates that it belongs to the requested repository, and appends the selected
environment. This supports both legacy name-based subjects and immutable
owner/repository-ID subjects. Do not construct the subject manually: repositories
created or moved after GitHub's immutable-subject rollout use a different value.

The script also validates the active account and region, validates referenced
AWS resources, deploys the named-IAM CloudFormation stack, enables stack
termination protection, and prints the stack outputs.

Set those outputs on the existing GitHub Environment:

```bash
GH_REPO='SharmaKunal14/slack-incidence-evidence'

DEPLOY_ROLE_ARN="$(
  aws cloudformation describe-stacks \
    --stack-name incident-copilot-development-deployment-bootstrap \
    --query "Stacks[0].Outputs[?OutputKey=='DeploymentRoleArn'].OutputValue" \
    --output text
)"
LAMBDA_BOUNDARY_ARN="$(
  aws cloudformation describe-stacks \
    --stack-name incident-copilot-development-deployment-bootstrap \
    --query "Stacks[0].Outputs[?OutputKey=='LambdaRolePermissionsBoundaryArn'].OutputValue" \
    --output text
)"
WORKFLOW_BOUNDARY_ARN="$(
  aws cloudformation describe-stacks \
    --stack-name incident-copilot-development-deployment-bootstrap \
    --query "Stacks[0].Outputs[?OutputKey=='WorkflowRolePermissionsBoundaryArn'].OutputValue" \
    --output text
)"

gh variable set AWS_DEPLOY_ROLE_ARN \
  --repo "$GH_REPO" --env development --body "$DEPLOY_ROLE_ARN"
gh variable set AWS_LAMBDA_ROLE_PERMISSIONS_BOUNDARY_ARN \
  --repo "$GH_REPO" --env development --body "$LAMBDA_BOUNDARY_ARN"
gh variable set AWS_WORKFLOW_ROLE_PERMISSIONS_BOUNDARY_ARN \
  --repo "$GH_REPO" --env development --body "$WORKFLOW_BOUNDARY_ARN"
```

Do not delete or detach the old deploy role yet. First verify that no workflow
run is using it and complete a successful deployment through the new role.
If the state bucket policy, state-key policy, or migration-secret KMS key policy
names the old role explicitly, add the new `DeploymentRoleArn` before switching
GitHub. An identity policy cannot override an explicit resource-policy deny.

## Recovering the failed apply

The failed Terraform apply may have created valid resources and recorded them
in the remote state. Do not delete the state or manually delete those resources.

For an existing environment, the state object key is part of the environment's
identity. Reuse the key that already owns the application resources; do not
invent a new key from an example. Before changing `TF_STATE_KEY`, list the
environment's state objects and inspect each candidate's lineage and resources:

```bash
aws s3api list-objects-v2 \
  --bucket "$TF_STATE_BUCKET" \
  --prefix "incident-copilot/${DEPLOYMENT_ENVIRONMENT:-development}/" \
  --query 'Contents[?ends_with(Key, `.tfstate`)].{Key:Key,Modified:LastModified,Size:Size}' \
  --output table
```

An empty state under a new key does not adopt existing AWS resources. Terraform
will instead try to create duplicates. If multiple state objects exist, stop and
compare their resource addresses and AWS IDs before selecting one.

Inspect the same remote state from CloudShell:

```bash
cat >/tmp/incident-copilot-backend.hcl <<EOF
bucket       = "$TF_STATE_BUCKET"
key          = "$TF_STATE_KEY"
region       = "$AWS_REGION"
encrypt      = true
use_lockfile = true
kms_key_id   = "$TF_STATE_KMS_KEY_ARN"
EOF

terraform -chdir=infrastructure/terraform init \
  -input=false \
  -reconfigure \
  -backend-config=/tmp/incident-copilot-backend.hcl
terraform -chdir=infrastructure/terraform state list
```

State inspection is read-only. A subsequent pipeline run will refresh those
objects, plan only what remains, reject deletes/replacements, and continue the
same deployment.

## Security boundaries and unavoidable wildcards

No policy grants administrator access, wildcard actions, IAM managed-policy
creation, IAM policy attachment, boundary removal, or unrestricted role
passing.

The deployer can create IAM roles only when the request includes the exact
runtime permissions boundary and the Terraform application/environment tags.
It can pass only environment-prefixed roles, and only to Lambda or Step
Functions.

Some AWS APIs do not expose a useful resource ARN before creation. Wildcard
resources therefore remain for narrowly enumerated actions, including:

- CloudFront origin access control and response-header policy creation;
- CloudFront provider reads and updates for generated IDs, including discovery
  of the AWS-managed cache and origin-request policies referenced by Terraform;
- deletion of only the API Gateway `/apis/*/cors` child configuration when an
  environment moves its browser traffic from cross-origin to same-origin;
- tagged CloudWatch alarm creation because `PutMetricAlarm` does not support a
  pre-existing resource ARN;
- Cognito user-pool creation and domain discovery;
- Lambda event-source mapping reads and updates for generated UUIDs;
- API Gateway v2 child resources under generated API IDs;
- provider list/describe operations; and
- runtime CloudWatch Logs delivery and optional Lambda VPC ENI operations.

These exceptions are limited by the exact GitHub repository/environment OIDC
subject, one AWS account, one environment role, action allow-lists, predictable
resource names where AWS supports them, mandatory runtime-role boundaries, and
Terraform's no-delete plan gate. CloudFront OAC and response-header policy APIs
have the weakest resource scoping; isolate production in a separate AWS account.

Bootstrap changes require a privileged human review because this stack controls
the CI deployment authorization boundary. Never run it automatically from the
role it creates.
