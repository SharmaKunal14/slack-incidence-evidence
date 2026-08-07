# Serverless AWS foundation

This Terraform root creates the cost-conscious AWS execution boundary for
Incident Evidence Copilot. It replaces always-running ingress and queue-polling
containers with API Gateway, Lambda, SQS, and Step Functions while preserving
the application's at-least-once and idempotency assumptions.

## What it creates

- An API Gateway HTTP API with one Slack-HMAC-authenticated public route, one
  public browser-bound Slack OAuth callback, and eight Cognito-JWT routes.
- A short-lived Slack ingress Lambda behind that route.
- An encrypted SQS FIFO queue, encrypted FIFO dead-letter queue, redrive policy,
  explicit redrive allow policy, and resource policies denying non-TLS access.
- An SQS event source mapping with a batch size of one and
  `ReportBatchItemFailures` enabled.
- An incident worker Lambda which consumes the job and starts a Standard Step
  Functions execution.
- A Slack evidence collector Lambda which retrieves and persists one bounded
  triggering-thread page per invocation.
- An incident analysis Lambda which loads a bounded evidence manifest, calls the
  OpenAI Responses API, and transactionally persists structured cited output.
- An incident report Lambda which writes only from structured analysis sources,
  validates every source reference, and transactionally persists a versioned
  draft and deterministic Markdown.
- A separate review-ready notifier Lambda which posts bounded counters to Slack
  and an authenticated console link and has no model-provider credentials.
- A bounded human-review API Lambda with a separate IAM role and, in production,
  a required dedicated least-privilege PostgreSQL credential.
- An authenticated integrations screen which shows membership-scoped Slack
  connection status and starts browser-bound OAuth without exposing credentials.
- Separate Slack onboarding start, callback, and disconnect Lambdas. The
  callback and disconnect functions can read the Slack OAuth client secret; the
  callback uses it to exchange an authorization code, while the disconnect
  function uses it to uninstall exactly the selected app installation. Only the
  callback can create installation credentials. The disconnect Lambda can read
  and schedule recoverable deletion only for installation credentials under the
  environment-scoped prefix.
- Workspace-aware Slack runtime adapters which resolve only the active OAuth
  installation for the operation's Slack team. Runtime IAM can read only the
  environment's installation-secret prefix; there is no global-token fallback.
- A Cognito reviewer pool using authorization-code + PKCE and optional TOTP
  MFA. Operator-created accounts are the default; verified self-registration
  can be enabled explicitly for a public onboarding environment.
- A private, encrypted, versioned S3 bucket exposed only through an origin-
  access-controlled CloudFront review console with restrictive response headers.
- Non-cached CloudFront `/review/*` and `/onboarding/*` behaviors which proxy to
  API Gateway. Browser API calls and the HttpOnly OAuth binding cookie therefore
  remain same-origin; the Slack Events API continues to use API Gateway directly.
- A scheduled, single-concurrency publication Lambda which leases approved
  revisions from a transactional PostgreSQL outbox, creates one complete page
  in the configured Confluence or Notion destination, checkpoints its URL, and
  posts the final link to the triggering Slack thread.
- A Standard workflow which loops over durable Slack page checkpoints, waits on
  Slack rate-limit hints, then runs leased structured extraction with durable
  model retry waits without holding Lambda compute, then generates a leased
  report draft and posts a content-free review notification.
- Resource-scoped IAM policies for queue and secret access and for starting the
  workflow. The Step Functions logging APIs are the documented exception that
  require wildcard resources.
- Bounded-retention CloudWatch log groups.
- Reserved Lambda concurrency limits to protect cost, Slack/GitHub quotas, and
  the future database connection budget.
- Alarms for failed jobs in the DLQ, excessive source-queue age, failed evidence
  workflows, publication Lambda errors, and exhausted publication retries.

All ten functions use the same immutable ZIP artifact but have separate
handlers, roles, environment variables, memory, timeouts, and concurrency
limits.

## Architecture and trust boundaries

```text
Slack
  -> API Gateway HTTP API
  -> Slack ingress Lambda (verify exact raw bytes, enqueue, acknowledge)
  -> SQS FIFO
  -> incident worker Lambda (idempotent database operation)
  -> Step Functions Standard
     -> Slack evidence collector Lambda (one page)
        -> Slack Web API + PostgreSQL checkpoint/artifacts
     -> Choice -> Wait -> next page, complete, or fail
     -> incident analysis Lambda
        -> PostgreSQL lease/evidence + OpenAI Responses API
        -> PostgreSQL timeline/claims/citations/questions
     -> Choice -> Wait -> retry, complete, or fail
     -> incident report Lambda
        -> PostgreSQL structured sources + OpenAI Responses API
        -> versioned report sections/statements/source links + Markdown
     -> Choice -> Wait -> retry, ready, or fail
     -> review-ready notification Lambda -> Slack Web API
        -> authenticated CloudFront review URL

Reviewer browser -> Cognito authorization code + PKCE
                 -> CloudFront (non-cached API behavior)
                 -> API Gateway JWT authorizer
                 -> review API Lambda
                 -> active tenant membership + PostgreSQL review transaction

Reviewer browser -> CloudFront /onboarding/* (browser-bound HttpOnly cookie)
                 -> API Gateway -> Slack onboarding Lambdas

Approval transaction -> PostgreSQL report_publications outbox
EventBridge schedule -> publication Lambda (leased, bounded retries)
                     -> configured Confluence space or Notion data source
                     -> PostgreSQL provider-neutral page checkpoint
                     -> Slack Web API final thread link
                     -> PostgreSQL completion checkpoint
```

API Gateway throttling is a cost and abuse guard; it is **not** Slack
authentication. The Lambda must still verify Slack's HMAC signature over the
exact request bytes and reject stale requests before parsing the event.

The queue and Lambda integration are at-least-once. SQS FIFO deduplication only
suppresses rapid duplicate sends; PostgreSQL uniqueness remains the durable
idempotency boundary. The Lambda integration therefore reports per-record
failures and never assumes exactly-once execution.

## Deliberately outside this foundation

This root does **not** create:

- A VPC, subnets, NAT gateway, VPC endpoints, or security groups.
- PostgreSQL or its managed connection pooler.
- Secrets Manager secrets or secret values.
- The Lambda ZIP artifact.
- A custom domain, WAF, Route 53 records, or an ACM certificate.
- An SNS topic for alarm delivery.
- Remote Terraform state infrastructure.

Those omissions are intentional. They prevent one early portfolio environment
from paying for unused fixed-cost infrastructure and prevent credentials from
being copied into Terraform state.

The worker accepts an existing PostgreSQL hostname and database secret ARN. The
current hosted deployment uses Supabase's IPv4 transaction pooler on port 6543,
which is designed for transient serverless clients. The connection uses TLS
with CA and hostname verification; credentials and the trusted CA bundle are
read from Secrets Manager and never enter Terraform state.

Leave both VPC input lists empty for Supabase's public pooler. When both lists
are supplied, database-using functions are attached to those subnets and receive
the minimal Lambda ENI-management IAM actions. A private deployment then needs either
Secrets Manager and Step Functions interface endpoints or controlled NAT egress
to reach those AWS APIs. Slack, Amazon Comprehend, OpenAI, Confluence, and
Notion calls require deliberate
HTTPS egress; a private-subnet deployment without NAT or another approved
egress path will fail. Supabase PrivateLink can replace the public database path
when its cost and availability requirements justify it.

## Secret contracts

Supply only secret **ARNs** to Terraform. The functions retrieve values at
runtime and cache them within the Lambda execution environment.

Slack signing secret (ingress access only):

```json
{
  "signingSecret": "actual Slack signing secret"
}
```

Slack bot token (worker and Slack collector access only):

```json
{
  "workspaceId": "T0123456789",
  "botToken": "actual Slack bot token"
}
```

Slack OAuth app secret (onboarding callback access only):

```json
{
  "clientSecret": "actual Slack OAuth client secret"
}
```

The public client ID and app ID are normal Terraform inputs. The client secret
is never entered by a customer and never enters Terraform state or Lambda
environment variables. Each completed installation is written to an
attempt-scoped Secrets Manager secret encrypted by
`slack_installation_kms_key_arn`.

Keep these as separate secrets. Request authentication does not require an API
token, and outbound Slack access does not require the signing secret. The
outbound adapters validate that every requested workspace matches the workspace
bound to the token before making an API request. The app needs `chat:write` for
status replies and `channels:history` for public-channel thread retrieval, in
addition to ingress's `app_mentions:read`. Incident analysis also needs
`users:read` so it can call `users.info` only for authors present in the selected
evidence; it does not request email access or enumerate the workspace directory.
Reinstall the Slack app after adding
a scope and update the secret if Slack issues a new bot token. The app must be
able to access the triggering channel.

## PII de-identification

The analysis and report Lambdas call Amazon Comprehend `DetectPiiEntities` in
the deployment region. Deterministic rules first replace known Slack identities,
mentions, email addresses, phone numbers, IP addresses, and common secret-token
formats. Comprehend then detects unstructured PII such as names and addresses.
Input de-identification runs up to three bounded detect-and-redact passes plus a
final confirmation scan, so entities exposed by an earlier replacement can be
removed without unbounded calls. Generated output remains a strict scan-only
gate because rewriting structured output could invalidate evidence citations.
`DATE_TIME` output findings are allowed because incident timestamps are required
evidence and are already included in the structured model input; free-form input
dates remain subject to redaction. Every other managed PII category remains
blocking. Detector failure or a remaining blocking finding prevents the model
call or report persistence. Logs contain only the scan operation, pass, finding
count, and normalized entity types; detected values and offsets are never
logged.

When analysis or report generation fails terminally, the workflow posts a
content-free Slack reply before entering its failed state. The reply contains
only the incident reference, failed stage, and operator-attention status; the
internal failure code and evidence content are excluded.

Configure `pii_language_code` (`en` or `es`), `pii_min_confidence`,
`pii_detection_concurrency`, and `pii_detection_timeout_milliseconds` through
Terraform. Comprehend PII detection does not support other languages. This is
pseudonymisation and risk reduction, not a guarantee of legal anonymisation.
Raw Slack evidence remains in the evidence store under its existing retention
and access controls; it is not sent to OpenAI.

Pipeline database connection secret:

```json
{
  "username": "postgres.your-project-reference",
  "password": "actual database password",
  "caCertificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
}
```

The review database secret has the same JSON shape. Production must use a
different non-owner PostgreSQL login and set `review_database_secret_arn`.
Development may omit it temporarily and reuse `database_secret_arn`; that
fallback is explicitly rejected when `environment = "production"`.

Create the login password outside source control, place that credential and the
trusted CA in Secrets Manager, grant `CONNECT` on the target database, and apply
the checked-in table grants as a database owner:

```bash
psql "$ADMIN_DATABASE_URL" \
  --set=review_role=incident_review_api \
  --file=db/security/review_api_grants.sql
```

Reapply this grant script when deploying the customer-facing Slack status API;
the review role now needs read-only access to `tenants` and
`slack_installations`. No credential value is stored in either table or returned
to the browser.

The script cannot make an owner credential least-privileged. A real production
deployment also needs a non-owner pipeline role; otherwise a compromised
pipeline runtime can bypass the intended table separation.

The onboarding database secret uses the same JSON shape. Production must set
`onboarding_database_secret_arn` to a separate non-owner login. Apply only the
tables and columns needed to create OAuth state, establish the first admin,
activate or disconnect a Slack installation, and write lifecycle audit events:

```bash
psql "$ADMIN_DATABASE_URL" \
  --set=onboarding_role=incident_slack_onboarding \
  --file=db/security/slack_onboarding_grants.sql
```

Slack ingress also resolves installation metadata before opening a modal. In
production, set `slack_runtime_database_secret_arn` to a dedicated non-owner
login and apply its read-only grants:

```bash
psql "$ADMIN_DATABASE_URL" \
  --set=slack_runtime_role=incident_slack_runtime \
  --file=db/security/slack_runtime_credential_grants.sql
```

Development may omit this input and reuse `database_secret_arn`. That fallback
is rejected in production. The role reads installation metadata only; the bot
token remains in the referenced Secrets Manager secret.

The publication database secret uses the same JSON shape. Production must use
a separate non-owner PostgreSQL login and set
`publication_database_secret_arn`. Apply its narrowly scoped grants as the
database owner:

```bash
psql "$ADMIN_DATABASE_URL" \
  --set=publication_role=incident_publication_worker \
  --file=db/security/publication_worker_grants.sql
```

OpenAI API secret (analysis and report Lambdas only):

```json
{
  "apiKey": "actual OpenAI API key"
}
```

Create a separate provider project and key per environment, restrict its spend,
and rotate it independently. Only the secret ARN enters Terraform. The model is
an explicit non-secret Terraform input; production should prefer a reviewed,
pinned model snapshot so behavior does not change without a deployment. The
application sends `store: false`, but provider retention, training, region, and
contractual controls still require an explicit organisational review.

Notion API secret (publication Lambda only):

```json
{
  "apiToken": "actual Notion internal integration token"
}
```

Create a Notion internal integration with **Read content** and **Insert
content** capabilities. Create a destination data source with a title property
named `Name` and a rich-text property named `Incident ID`, then explicitly
share the parent database with the integration. Set `notion_data_source_id` to
the data source ID—not the browser database ID when those differ. Property names
are configurable through `notion_title_property` and
`notion_incident_id_property`.

The exact `Incident ID` query is the external deduplication boundary. Notion
does not enforce uniqueness for rich-text properties, so operators must not
manually duplicate an incident ID; the worker fails closed if it finds multiple
matches. Pages inherit the parent database's Notion permissions. Posting a URL
to Slack does not grant Notion access, but the destination ACL must still be
reviewed so incident data is not exposed to a broader audience than intended.
The adapter uses Notion API `2026-03-11` and keeps each create request below the
documented block, rich-text, and payload limits.

Confluence Cloud API secret (publication Lambda only):

```json
{
  "email": "dedicated-publisher@example.com",
  "apiToken": "actual Atlassian API token"
}
```

Set `publication_provider = "CONFLUENCE"`, `confluence_base_url` to the plain
`https://<site>.atlassian.net` human-facing site origin,
`confluence_cloud_id` to the Cloud ID required by a scoped token, and
`confluence_space_id` to the numeric space ID. `confluence_parent_page_id` is
optional. The account should be a
dedicated service account with view/create-page permission only in the target
space. The Lambda's IAM role can read only the selected provider secret.

Retrieve the Cloud ID from the site-owned metadata endpoint:

```bash
curl --fail --silent --show-error \
  "https://<site>.atlassian.net/_edge/tenant_info" |
jq -r '.cloudId'
```

When `confluence_cloud_id` is set, API calls go to
`https://api.atlassian.com/ex/confluence/<cloud-id>/wiki/api/v2/...`, which is
required for scoped API tokens. The separate `confluence_base_url` is used only
to construct and validate the human-facing page URL posted to Slack. Omitting
`confluence_cloud_id` retains the site-specific API endpoint solely for true
classic tokens.

The publisher requires the scoped-token permissions `read:page:confluence` and
`write:page:confluence`, plus the service account's site and target-space
permissions. A manual `GET /wiki/api/v2/spaces` diagnostic additionally requires
`read:space:confluence`; that broader scope is not needed by the publisher's
page lookup and creation requests.

The adapter uses the [Confluence Cloud REST API v2 page
endpoints](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/).
It performs an exact lookup using
a stable title containing the incident UUID, fails closed on ambiguous results,
escapes every untrusted value before generating Confluence storage-format HTML,
and validates returned links against the configured Atlassian origin. API-token
Basic authentication is appropriate for this self-hosted internal development
integration. A distributable multi-tenant product must replace it with one
centrally managed OAuth 2.0 (3LO) application rather than collecting customer
API tokens. See Atlassian's [Basic authentication security
guidance](https://developer.atlassian.com/cloud/confluence/basic-auth-for-rest-apis/)
and [scoped-token endpoint
requirements](https://support.atlassian.com/confluence/kb/scoped-api-tokens-in-confluence-cloud/).

`publication_provider` is an environment-level switch. Set it to `NOTION` to
use the preserved Notion adapter or `CONFLUENCE` for Confluence; no application
code changes are required. A job is pinned to its provider on its first lease.
This prevents a configuration change from publishing an ambiguous prior attempt
to a second system. A page already checkpointed by the old provider can still
finish its Slack notification after a switch.

The database host, port, name, and mandatory TLS setting are separate non-secret
environment variables. A complete `DATABASE_URL` is intentionally never
constructed in Terraform, so the password cannot leak into plans or state.
Each database-using Lambda passes the trusted CA bundle explicitly to PostgreSQL with
`rejectUnauthorized=true`, which verifies both the certificate chain and the
pooler hostname. The secret parser rejects missing, malformed, or unexpected
fields before opening a connection. Keeping the CA in the already-required
secret adds no API call and permits CA rotation without rebuilding the Lambda.

Download the CA from the Supabase dashboard's **Database > SSL Configuration**
section. Do not bootstrap trust by copying the root from an unverified server
handshake. Add the PEM as `caCertificate` to the existing JSON secret before
deploying this version.

If any supplied secret uses a customer-managed KMS key, pass its ARN in
`secrets_kms_key_arns`. The resulting `kms:Decrypt` grant is restricted to calls
through Secrets Manager in the selected region.

Secret ARNs and resource metadata will still appear in Terraform state. Treat
the state as sensitive operational metadata and store production state in an
encrypted, versioned remote backend with locking and tightly scoped access.

## Lambda artifact contract

`lambda_artifact_path` must point to one ZIP containing all composition roots
at its root:

```text
package.json                 declares the bundle as CommonJS
slack-ingress-main.js        exports handler
incident-worker-main.js      exports handler
slack-evidence-collector-main.js exports handler
incident-analysis-main.js       exports handler
incident-report-main.js         exports handler
incident-review-notification-main.js exports handler
incident-review-api-main.js          exports handler
approved-report-publication-main.js  exports handler
```

The defaults are therefore:

```hcl
ingress_lambda_handler = "slack-ingress-main.handler"
worker_lambda_handler  = "incident-worker-main.handler"
slack_evidence_collector_lambda_handler = "slack-evidence-collector-main.handler"
incident_analysis_lambda_handler = "incident-analysis-main.handler"
incident_report_lambda_handler = "incident-report-main.handler"
incident_review_notification_lambda_handler = "incident-review-notification-main.handler"
incident_review_api_lambda_handler = "incident-review-api-main.handler"
approved_report_publication_lambda_handler = "approved-report-publication-main.handler"
```

Build for the selected `lambda_architecture`; the default is `arm64`. Pure
JavaScript packages are portable, but any future native dependency must be
compiled for Amazon Linux and the chosen architecture. Terraform uses
`filebase64sha256` so an artifact change produces a deterministic Lambda update.

## Deploying a development foundation

Prerequisites:

- Terraform 1.10 or newer. Automated deployments use native S3 lockfiles.
- AWS credentials for a non-production account.
- A `zip` command-line utility used by `npm run build:lambda`.
- The built Lambda artifact.
- The built review console assets (`npm run build:web`).
- Existing Slack signing, Slack bot-token, database, OpenAI, and selected
  publication-provider Secrets Manager secret ARNs.
- Either a Confluence Cloud space accessible to the dedicated publisher account
  or a Notion data source shared with the Notion integration.
- An existing PostgreSQL endpoint. For the current Supabase deployment, use the
  transaction-pooler hostname, port 6543, and empty VPC input lists.
- Database migrations through `0010_auto_discovered_slack_threads.sql` applied
  before the updated workflow is deployed or invoked.

Create an ignored variable file:

```bash
cd infrastructure/terraform
cp terraform.tfvars.example terraform.tfvars
cd ../..
```

Replace all example account IDs, ARNs, artifact paths, and hostnames. Never put
secret values in `terraform.tfvars`. `slack_auto_thread_max_count` defaults to
50 automatically expanded roots per selected channel and is hard-bounded to
500; lower it if workspace rate limits or incident volume require a smaller
collection budget.

Public self-service onboarding is disabled by default. For an intentionally
public pilot, add `"review_self_signup_enabled": true` to the deployment
environment's `TF_INPUTS_JSON`. Cognito then requires email verification before
the visitor can enter the console. Do not enable this merely to avoid creating
test users: public registration expands abuse, email-delivery, and cost exposure.

Build both deployable artifacts, then run:

```bash
npm run build:lambda
npm run build:web
cd infrastructure/terraform
terraform init
terraform fmt -check -recursive
terraform validate
terraform plan -out=tfplan
terraform apply tfplan
```

Apply database migrations **before** `terraform apply` updates the workflow. The
migration CLI uses a PostgreSQL advisory lock and must run through a
session-capable connection (for Supabase, the session pooler on port 5432), not
the transaction pooler on port 6543 used by Lambda. An incident created before
migration 0002 has no triggering message timestamp; create a new Slack trigger
instead of attempting to collect that old record.

After a new Slack trigger completes, verify durable analysis and report state:

```sql
select id, status, model_name, attempt_count,
       input_artifact_count, input_tokens, output_tokens,
       timeline_event_count, claim_count, open_question_count
from incident_analysis_runs
order by started_at desc
limit 5;

select incident_id, count(*) as generated_claims
from claims
where analysis_run_id is not null
group by incident_id;

select id, incident_id, analysis_run_id, status, model_name,
       attempt_count, section_count, statement_count,
       input_tokens, output_tokens, finished_at
from incident_report_drafts
order by started_at desc
limit 5;

select d.id, d.status, d.rendered_markdown
from incident_report_drafts d
where d.status = 'NEEDS_REVIEW'
order by d.finished_at desc
limit 1;
```

The expected workflow state before review is success, the analysis run is
`COMPLETE`, generated claims remain `UNREVIEWED`, the report draft is
`NEEDS_REVIEW`, and the incident advances to `NEEDS_REVIEW`. The draft is not
published. After an authorized reviewer approves a revision, the revision and
incident become `APPROVED` and a publication job is committed atomically. The
scheduled worker normally publishes within one minute, subject to bounded
provider retries.

After apply, obtain the Slack URL:

```bash
terraform output -raw slack_events_url
terraform output -raw review_console_url
terraform output -raw reviewer_user_pool_id
```

Configure that value as the Slack app's Events API request URL.

Create a development reviewer in Cognito, obtain its immutable `sub`, and add
an active membership for the Slack workspace tenant. This is an operator action;
the review API intentionally cannot grant its own access:

```bash
USER_POOL_ID="$(terraform output -raw reviewer_user_pool_id)"
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username reviewer@example.com \
  --user-attributes Name=email,Value=reviewer@example.com Name=email_verified,Value=true

aws cognito-idp admin-get-user \
  --user-pool-id "$USER_POOL_ID" \
  --username reviewer@example.com
```

Use the returned `sub` in a parameterized SQL statement (the literal below is
illustrative, not shell interpolation):

```sql
insert into reviewer_memberships (
  tenant_id, cognito_subject, role, status
) values (
  'T0123456789', '<cognito-sub-uuid>', 'REVIEWER', 'ACTIVE'
)
on conflict (tenant_id, cognito_subject) do update
set role = excluded.role,
    status = 'ACTIVE',
    revoked_at = null,
    updated_at = statement_timestamp();
```

Open `review_console_url`, complete the temporary-password flow, open an
incident, save one immutable revision, and approve it. Verify the durable result:

```sql
select id, incident_id, revision_number, status, created_by_subject,
       approved_by_subject, created_at, approved_at
from report_revisions
order by created_at desc
limit 5;

select incident_id, report_revision_id, approved_by_subject, approved_at
from report_approvals
order by approved_at desc
limit 5;

select id, incident_id, report_revision_id, status, attempt_count,
       publisher, published_page_url, slack_message_ts, last_error_code,
       created_at, completed_at, failed_at
from report_publications
order by created_at desc
limit 5;
```

The final expected publication status is `COMPLETE`, with both
`published_page_url` and `slack_message_ts` populated. `PAGE_PUBLISHED` means the
provider page is durable but Slack delivery is still retrying. `FAILED` requires
operator diagnosis before an audited retry. Migration 0006 backfills `PENDING`
jobs for older approvals; migration 0007 preserves Notion checkpoints and makes
new unattempted jobs eligible for the configured provider.

After switching providers, inspect pinned incomplete jobs explicitly:

```sql
select id, publisher, status, attempt_count, last_error_code
from report_publications
where status in ('PENDING', 'FAILED')
  and publisher is not null
  and publisher <> 'CONFLUENCE';
```

Do not reset `publisher` automatically. An earlier request may have created a
page even when the worker received a network timeout. Resolve the provider page
manually before an audited retry or reassignment.

## Production state and CI/CD

The checked-in GitHub Actions pipeline, environment variables, OIDC boundary,
state bootstrap, migration ordering, and promotion gates are documented in
[the deployment pipeline runbook](../../docs/deployment-pipeline.md). The OIDC
deployment role and mandatory runtime-role permissions boundary are managed by
the separate [bootstrap stack](../bootstrap/README.md).

This reusable root intentionally omits a hard-coded backend because backend
configuration differs by AWS account and cannot use normal input variables.
Production CI should supply an S3 backend configuration with bucket versioning,
SSE-KMS, and DynamoDB/S3 locking according to the team's Terraform version and
policy. Use a separate state, AWS account, Slack app, secrets, and artifact
promotion path for development, staging, and production.

Deploy immutable artifacts by commit SHA:

1. Test and bundle all Lambda composition roots.
2. Publish the artifact to the trusted CI workspace (or evolve this root to a
   versioned S3 artifact once a release pipeline exists).
3. Run `terraform plan` and preserve it for review.
4. Apply to staging and execute a signed Slack webhook smoke test.
5. Promote the same artifact digest to production with manual approval.

## Scaling and cost controls

- API Gateway and all Lambdas charge primarily when used; no ALB or ECS tasks
  remain running while the project is idle.
- Ingress, worker, collector, analysis, report, notification, review, and
  publication concurrency are independent and explicitly capped.
- The SQS event source's maximum concurrency equals the worker's reserved
  concurrency, preventing the poller from creating avoidable Lambda throttles.
- The FIFO queue buffers bursts and the oldest-message alarm exposes backlog.
- Batch size one keeps failure semantics and per-incident cost visible at the
  current low volume. Increase only after measuring duration and downstream
  quotas.
- `MessageGroupId` is a bounded hash of workspace, channel, and incident thread
  (or triggering message), so duplicate deliveries remain ordered without
  serializing unrelated incidents across an entire tenant.
- Step Functions execution data is excluded from logs to reduce both sensitive
  data exposure and log volume.
- The collector reads at most 16 thread message objects per invocation (the
  parent plus a page of 15 replies), resolves
  permalinks with concurrency three, and has its own reserved-concurrency cap.
  A stored cursor makes each page independently retryable; a configurable page
  limit and cursor-progress check prevent unbounded executions.
- Analysis has independent artifact, character, output-token, timeout, attempt,
  lease, and reserved-concurrency budgets. A completed analysis version is a
  database no-op on retry; active duplicates wait behind the persisted lease.
- Report generation has separate source, character, output-token, timeout,
  attempt, lease, and concurrency budgets. It never receives raw Slack evidence.
- Standard workflows are appropriate for durable, auditable, human-scale
  incident processing. Model requests and large evidence must live in S3 or
  PostgreSQL, not in workflow state.
- Publication uses a once-per-minute scheduler rather than holding a workflow
  open during human review. PostgreSQL is the durable queue, an expiring lease
  handles worker death, the external page is checkpointed before Slack, and
  default batch size one bounds provider and database pressure.

Lambda can scale faster than Slack, GitHub, model providers, or PostgreSQL.
Raise reserved concurrency only after checking all four budgets. Cap concurrency
against the Supabase pooler and project connection limits rather than treating
Lambda's regional quota as a target.

## Operational alarms

The stack always creates alarm state even when it has no notification target.
Pass one or more SNS topic ARNs through `alarm_action_arns` to route alerts.

- **DLQ visible messages:** alarms immediately when any job exhausts retries.
- **Oldest source message:** alarms after two consecutive periods above the
  configured age threshold.
- **Failed workflow:** alarms when collection, analysis, or report generation reaches a terminal
  failure or exhausts infrastructure retries.
- **Publication errors:** alarms on unhandled scheduled-worker failures.
- **Publication retries exhausted:** a log-derived alarm identifies an approved
  report that could not complete provider or Slack delivery.

The configured evidence-retention period sets `retention_expires_at`; this
release does not yet run an expiry deletion processor. Do not describe the data
as automatically deleted until that job and its backup semantics are deployed
and tested.

The DLQ is not an archive. Diagnose the dependency or data failure, deploy a
fix, and use an audited redrive procedure. Database and publication side effects
must be idempotent before redriving.
