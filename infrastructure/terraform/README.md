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
- A deliberately honest workflow whose only current state is
  `WorkflowAccepted` (`Succeed`). Collection, extraction, review, and publishing
  states will be added as their application handlers are implemented.
- Resource-scoped IAM policies for queue and secret access and for starting the
  workflow. The Step Functions logging APIs are the documented exception that
  require wildcard resources.
- Bounded-retention CloudWatch log groups.
- Reserved Lambda concurrency limits to protect cost, Slack/GitHub quotas, and
  the future database connection budget.
- Alarms for failed jobs in the DLQ and excessive source-queue age.

Both functions use the same immutable ZIP artifact but have separate handlers,
roles, environment variables, memory, timeouts, and concurrency limits.

## Architecture and trust boundaries

```text
Slack
  -> API Gateway HTTP API
  -> Slack ingress Lambda (verify exact raw bytes, enqueue, acknowledge)
  -> SQS FIFO
  -> incident worker Lambda (idempotent database operation)
  -> Step Functions Standard (currently WorkflowAccepted)
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
- RDS PostgreSQL or RDS Proxy.
- Secrets Manager secrets or secret values.
- The Lambda ZIP artifact.
- A custom domain, WAF, Route 53 records, or an ACM certificate.
- An SNS topic for alarm delivery.
- Remote Terraform state infrastructure.

Those omissions are intentional. They prevent one early portfolio environment
from paying for unused fixed-cost infrastructure and prevent credentials from
being copied into Terraform state.

The worker accepts an existing RDS Proxy hostname, database secret ARN, private
subnet IDs, and security group IDs. When both network lists are supplied, it is
attached to those subnets and receives the minimal Lambda ENI-management IAM
actions. Terraform rejects a production plan without both lists. This root does
not create or configure those resources: the next infrastructure layer must
provision the VPC, RDS Proxy, and narrowly scoped security group path.

Empty VPC inputs are allowed only for cheap development with an externally
reachable TLS PostgreSQL endpoint. That is not an acceptable production design.
Once attached to private subnets, the worker needs either Secrets Manager and
Step Functions interface endpoints or controlled NAT egress to reach those AWS
APIs. Future Slack, GitHub, and hosted-model calls also require controlled
internet egress; interface endpoints do not replace NAT for those services.

## Secret contracts

Supply only secret **ARNs** to Terraform. The functions retrieve values at
runtime and cache them within the Lambda execution environment.

Slack signing secret:

```json
{
  "signingSecret": "actual Slack signing secret"
}
```

Database credential secret:

```json
{
  "username": "incident_application",
  "password": "actual database password"
}
```

The database host, port, name, and mandatory TLS setting are separate non-secret
environment variables. A complete `DATABASE_URL` is intentionally never
constructed in Terraform, so the password cannot leak into plans or state.
The Node.js 22 worker also loads Lambda's managed Amazon CA bundle through
`NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem` and the PostgreSQL client rejects
an untrusted server certificate. A later optimized artifact can bundle only the
regional RDS CA chain to reduce cold-start certificate loading.

If either secret uses a customer-managed KMS key, pass its ARN in
`secrets_kms_key_arns`. The resulting `kms:Decrypt` grant is restricted to calls
through Secrets Manager in the selected region.

Secret ARNs and resource metadata will still appear in Terraform state. Treat
the state as sensitive operational metadata and store production state in an
encrypted, versioned remote backend with locking and tightly scoped access.

## Lambda artifact contract

`lambda_artifact_path` must point to one ZIP containing both composition roots
at its root:

```text
package.json                 declares the bundle as CommonJS
slack-ingress-main.js        exports handler
incident-worker-main.js      exports handler
```

The defaults are therefore:

```hcl
ingress_lambda_handler = "slack-ingress-main.handler"
worker_lambda_handler  = "incident-worker-main.handler"
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
- Existing Slack and database Secrets Manager secret ARNs.
- An existing database endpoint. Production requires RDS Proxy and both private
  subnet and security group inputs described above.

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

1. Test and bundle both Lambda composition roots.
2. Publish the artifact to the trusted CI workspace (or evolve this root to a
   versioned S3 artifact once a release pipeline exists).
3. Run `terraform plan` and preserve it for review.
4. Apply to staging and execute a signed Slack webhook smoke test.
5. Promote the same artifact digest to production with manual approval.

## Scaling and cost controls

- API Gateway and both Lambdas charge primarily when used; no ALB or ECS tasks
  remain running while the project is idle.
- Ingress and worker concurrency are independent and explicitly capped.
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
- Standard workflows are appropriate for durable, auditable, human-scale
  incident processing. Model requests and large evidence must live in S3 or
  PostgreSQL, not in workflow state.

Lambda can scale faster than Slack, GitHub, model providers, or PostgreSQL.
Raise reserved concurrency only after checking all four budgets. When the worker
is attached to RDS Proxy, cap concurrency against the database connection limit
rather than treating Lambda's regional quota as a target.

## Operational alarms

The stack always creates alarm state even when it has no notification target.
Pass one or more SNS topic ARNs through `alarm_action_arns` to route alerts.

- **DLQ visible messages:** alarms immediately when any job exhausts retries.
- **Oldest source message:** alarms after two consecutive periods above the
  configured age threshold.

The DLQ is not an archive. Diagnose the dependency or data failure, deploy a
fix, and use an audited redrive procedure. Database and publication side effects
must be idempotent before redriving.
