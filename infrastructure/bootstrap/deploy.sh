#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  deploy.sh \
    --environment development \
    --github-repository OWNER/REPOSITORY \
    --state-bucket BUCKET \
    --state-key incident-copilot/development/terraform.tfstate \
    --state-kms-key-arn ARN \
    --migration-secret-arn ARN \
    [--migration-secret-kms-key-arn ARN]

The active CloudShell identity must be allowed to deploy a CloudFormation stack
containing named IAM resources. GitHub CLI must be authenticated for the target
repository. No secret values are accepted by this script.

For compatibility, --github-subject may be supplied instead of
--github-repository, but it must be copied from the effective GitHub OIDC token
configuration rather than constructed from repository names.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

project_name='incident-copilot'
environment=''
github_repository=''
github_subject=''
state_bucket=''
state_key=''
state_kms_key_arn=''
migration_secret_arn=''
migration_secret_kms_key_arn=''

while (($# > 0)); do
  case "$1" in
    --environment)
      (($# >= 2)) || fail '--environment requires a value'
      environment="$2"
      shift 2
      ;;
    --github-subject)
      (($# >= 2)) || fail '--github-subject requires a value'
      github_subject="$2"
      shift 2
      ;;
    --github-repository)
      (($# >= 2)) || fail '--github-repository requires a value'
      github_repository="$2"
      shift 2
      ;;
    --state-bucket)
      (($# >= 2)) || fail '--state-bucket requires a value'
      state_bucket="$2"
      shift 2
      ;;
    --state-key)
      (($# >= 2)) || fail '--state-key requires a value'
      state_key="$2"
      shift 2
      ;;
    --state-kms-key-arn)
      (($# >= 2)) || fail '--state-kms-key-arn requires a value'
      state_kms_key_arn="$2"
      shift 2
      ;;
    --migration-secret-arn)
      (($# >= 2)) || fail '--migration-secret-arn requires a value'
      migration_secret_arn="$2"
      shift 2
      ;;
    --migration-secret-kms-key-arn)
      (($# >= 2)) || fail '--migration-secret-kms-key-arn requires a value'
      migration_secret_kms_key_arn="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown argument: $1"
      ;;
  esac
done

[[ "$project_name" =~ ^[a-z][a-z0-9-]{1,29}$ ]] ||
  fail 'project name must be 2-30 lowercase alphanumeric or hyphen characters'
[[ "$environment" =~ ^(development|staging|production)$ ]] ||
  fail 'environment must be development, staging, or production'
[[ -z "$github_repository" || -z "$github_subject" ]] ||
  fail 'provide either --github-repository or --github-subject, not both'
[[ -n "$github_repository" || -n "$github_subject" ]] ||
  fail '--github-repository or --github-subject is required'
if [[ -n "$github_repository" ]]; then
  [[ "$github_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
    fail 'GitHub repository must use the OWNER/REPOSITORY format'
else
  [[ "$github_subject" =~ ^repo:[^:]+:environment:"$environment"$ ]] ||
    fail 'GitHub subject must target the selected environment'
fi
[[ "$state_bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] ||
  fail 'state bucket name is invalid'
[[ -n "$state_key" && "$state_key" != /* && "$state_key" != *'../'* ]] ||
  fail 'state key is empty, absolute, or contains parent traversal'
[[ -n "$state_kms_key_arn" ]] || fail 'state KMS key ARN is required'
[[ -n "$migration_secret_arn" ]] || fail 'migration secret ARN is required'

for command_name in aws; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "required command is unavailable: $command_name"
done
if [[ -n "$github_repository" ]]; then
  command -v gh >/dev/null 2>&1 || fail 'required command is unavailable: gh'

  github_subject_prefix="$(
    gh api \
      "repos/${github_repository}/actions/oidc/customization/sub" \
      --jq '.sub_claim_prefix'
  )"
  legacy_subject_prefix="repo:${github_repository}"
  if [[ "$github_subject_prefix" != "$legacy_subject_prefix" ]]; then
    [[ "$github_subject_prefix" =~ ^repo:([^@:/]+)@([0-9]+)/([^@:/]+)@([0-9]+)$ ]] ||
      fail 'GitHub returned an invalid OIDC subject prefix'
    resolved_github_owner="${BASH_REMATCH[1]}"
    resolved_github_repository="${BASH_REMATCH[3]}"
    [[ "$resolved_github_owner" == "${github_repository%%/*}" ]] ||
      fail 'GitHub OIDC subject owner does not match the requested repository'
    [[ "$resolved_github_repository" == "${github_repository#*/}" ]] ||
      fail 'GitHub OIDC subject repository does not match the requested repository'
  fi
  github_subject="${github_subject_prefix}:environment:${environment}"
fi

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
template_path="${script_directory}/deployment-role.json"
[[ -f "$template_path" ]] || fail "template not found: $template_path"

aws_region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
[[ "$aws_region" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]$ ]] ||
  fail 'AWS_REGION or AWS_DEFAULT_REGION must contain a valid AWS region'

aws_account_id="$(aws sts get-caller-identity --query Account --output text)"
[[ "$aws_account_id" =~ ^[0-9]{12}$ ]] || fail 'could not resolve AWS account ID'

expected_regional_arn_prefix="arn:aws:"
[[ "$state_kms_key_arn" == "${expected_regional_arn_prefix}kms:${aws_region}:${aws_account_id}:key/"* ]] ||
  fail 'state KMS key must belong to the active account and region'
[[ "$migration_secret_arn" == "${expected_regional_arn_prefix}secretsmanager:${aws_region}:${aws_account_id}:secret:"* ]] ||
  fail 'migration secret must belong to the active account and region'
if [[ -n "$migration_secret_kms_key_arn" ]]; then
  [[ "$migration_secret_kms_key_arn" == "${expected_regional_arn_prefix}kms:${aws_region}:${aws_account_id}:key/"* ]] ||
    fail 'migration secret KMS key must belong to the active account and region'
fi

oidc_provider_arn="arn:aws:iam::${aws_account_id}:oidc-provider/token.actions.githubusercontent.com"
aws iam get-open-id-connect-provider \
  --open-id-connect-provider-arn "$oidc_provider_arn" >/dev/null

aws s3api head-bucket --bucket "$state_bucket" >/dev/null
aws kms describe-key --key-id "$state_kms_key_arn" >/dev/null
aws secretsmanager describe-secret --secret-id "$migration_secret_arn" >/dev/null

stack_name="${project_name}-${environment}-deployment-bootstrap"
resource_prefix="${project_name}-${environment}"
review_bucket_name="${resource_prefix:0:24}-review-${aws_account_id}-${aws_region}"
parameters=(
  "ProjectName=${project_name}"
  "Environment=${environment}"
  "GitHubOidcProviderArn=${oidc_provider_arn}"
  "GitHubOidcSubject=${github_subject}"
  "StateBucketName=${state_bucket}"
  "StateObjectKey=${state_key}"
  "StateKmsKeyArn=${state_kms_key_arn}"
  "MigrationDatabaseSecretArn=${migration_secret_arn}"
  "MigrationSecretKmsKeyArn=${migration_secret_kms_key_arn}"
  "ReviewBucketName=${review_bucket_name}"
)

printf 'Deploying bootstrap stack %s in account %s, region %s\n' \
  "$stack_name" "$aws_account_id" "$aws_region"
printf 'Using GitHub OIDC subject %s\n' "$github_subject"

aws cloudformation deploy \
  --template-file "$template_path" \
  --stack-name "$stack_name" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${parameters[@]}" \
  --tags \
    "Application=${project_name}" \
    "Environment=${environment}" \
    'ManagedBy=CloudFormation'

aws cloudformation update-termination-protection \
  --enable-termination-protection \
  --stack-name "$stack_name" >/dev/null

aws cloudformation describe-stacks \
  --stack-name "$stack_name" \
  --query 'Stacks[0].Outputs[].{Name:OutputKey,Value:OutputValue}' \
  --output table

printf '\nSet the displayed role and both boundary ARNs in the matching GitHub Environment.\n'
