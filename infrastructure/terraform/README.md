# Serverless AWS foundation

This Terraform root creates the cost-conscious AWS execution boundary for
Incident Evidence Copilot. It replaces always-running ingress and queue-polling
containers with API Gateway, Lambda, SQS, and Step Functions while preserving
the application's at-least-once and idempotency assumptions.

## What it creates

- An API Gateway HTTP API with exactly one public route:
  `POST /integrations/slack/events`.
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
- A Standard workflow which loops over durable Slack page checkpoints, waits on
  Slack rate-limit hints, then runs leased structured extraction with durable
  model retry waits without holding Lambda compute.
- Resource-scoped IAM policies for queue and secret access and for starting the
  workflow. The Step Functions logging APIs are the documented exception that
  require wildcard resources.
- Bounded-retention CloudWatch log groups.
- Reserved Lambda concurrency limits to protect cost, Slack/GitHub quotas, and
  the future database connection budget.
- Alarms for failed jobs in the DLQ, excessive source-queue age, and failed
  evidence workflows.

All four functions use the same immutable ZIP artifact but have separate
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
to reach those AWS APIs. Slack and OpenAI calls require deliberate HTTPS egress;
a private-subnet deployment without NAT or another approved egress path will
fail. Supabase PrivateLink can replace the public database path when its cost and
availability requirements justify it.

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

Keep these as separate secrets. Request authentication does not require an API
token, and outbound Slack access does not require the signing secret. The
outbound adapters validate that every requested workspace matches the workspace
bound to the token before making an API request. The app needs `chat:write` for
status replies and `channels:history` for public-channel thread retrieval, in
addition to ingress's `app_mentions:read`. Reinstall the Slack app after adding
a scope and update the secret if Slack issues a new bot token. The app must be
able to access the triggering channel.

Database connection secret:

```json
{
  "username": "postgres.your-project-reference",
  "password": "actual database password",
  "caCertificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
}
```

OpenAI API secret (analysis Lambda access only):

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
```

The defaults are therefore:

```hcl
ingress_lambda_handler = "slack-ingress-main.handler"
worker_lambda_handler  = "incident-worker-main.handler"
slack_evidence_collector_lambda_handler = "slack-evidence-collector-main.handler"
incident_analysis_lambda_handler = "incident-analysis-main.handler"
```

Build for the selected `lambda_architecture`; the default is `arm64`. Pure
JavaScript packages are portable, but any future native dependency must be
compiled for Amazon Linux and the chosen architecture. Terraform uses
`filebase64sha256` so an artifact change produces a deterministic Lambda update.

## Deploying a development foundation

Prerequisites:

- Terraform 1.4 or newer.
- AWS credentials for a non-production account.
- A `zip` command-line utility used by `npm run build:lambda`.
- The built Lambda artifact.
- Existing Slack signing, Slack bot-token, database, and OpenAI Secrets Manager
  secret ARNs.
- An existing PostgreSQL endpoint. For the current Supabase deployment, use the
  transaction-pooler hostname, port 6543, and empty VPC input lists.
- Database migrations through `0003_incident_analysis.sql` applied before the
  updated workflow is deployed or invoked.

Create an ignored variable file:

```bash
cd infrastructure/terraform
cp terraform.tfvars.example terraform.tfvars
```

Replace all example account IDs, ARNs, artifact paths, and hostnames. Never put
secret values in `terraform.tfvars`.

Then run:

```bash
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

After a new Slack trigger completes, verify durable analysis without exposing
message content:

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
```

The expected terminal workflow state is success, the analysis run is
`COMPLETE`, generated claims remain `UNREVIEWED`, and the incident advances to
`GENERATING`. That status means extraction is ready for the next report-writing
stage; it does not mean a postmortem document already exists.

After apply, obtain the Slack URL:

```bash
terraform output -raw slack_events_url
```

Configure that value as the Slack app's Events API request URL.

## Production state and CI/CD

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
- Ingress, worker, collector, and analysis concurrency are independent and
  explicitly capped.
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
- The collector reads at most 15 thread messages per invocation, resolves
  permalinks with concurrency three, and has its own reserved-concurrency cap.
  A stored cursor makes each page independently retryable; a configurable page
  limit and cursor-progress check prevent unbounded executions.
- Analysis has independent artifact, character, output-token, timeout, attempt,
  lease, and reserved-concurrency budgets. A completed analysis version is a
  database no-op on retry; active duplicates wait behind the persisted lease.
- Standard workflows are appropriate for durable, auditable, human-scale
  incident processing. Model requests and large evidence must live in S3 or
  PostgreSQL, not in workflow state.

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
- **Failed workflow:** alarms when collection or analysis reaches a terminal
  failure or exhausts infrastructure retries.

The configured evidence-retention period sets `retention_expires_at`; this
release does not yet run an expiry deletion processor. Do not describe the data
as automatically deleted until that job and its backup semantics are deployed
and tested.

The DLQ is not an archive. Diagnose the dependency or data failure, deploy a
fix, and use an audited redrive procedure. Database and publication side effects
must be idempotent before redriving.
