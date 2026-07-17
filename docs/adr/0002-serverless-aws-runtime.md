# ADR 0002: Use API Gateway, Lambda, SQS, and Step Functions for the first AWS runtime

- Status: accepted
- Date: 2026-07-17
- Decision owners: project maintainers
- Amends: the production process topology in ADR 0001; its modular-monolith and dependency-boundary decisions remain accepted

## Context

The first deployment is a portfolio product with low idle traffic and short,
bursty activity during incidents. Paying continuously for an Application Load
Balancer and two Fargate services would buy operational familiarity, but it
would not buy better product behavior at the expected load. The workflow is also
expected to grow into collection, extraction, human review, and publication
stages with retries and waits that should survive a process restart.

Known constraints:

- Slack needs a fast acknowledgement after signature verification and durable
  queue acceptance.
- Slack and SQS both retry, so exactly-once delivery cannot be assumed.
- PostgreSQL is the system of record; Step Functions is orchestration history,
  not the owner of incident facts.
- Evidence and model payloads can exceed workflow-state limits and must remain in
  PostgreSQL or object storage.
- Lambda can scale faster than PostgreSQL and third-party quotas.

Assumptions still requiring deployment evidence:

- Real cold-start plus Secrets Manager and SQS latency stays inside the Slack
  acknowledgement budget under normal conditions.
- The selected RDS Proxy/network path, TLS trust, and connection budget work
  under Lambda concurrency.
- The low/bursty workload makes request-based pricing cheaper than continuously
  allocated containers. This must be revisited using bills and traces.

## Decision

Use the following AWS production adapters while preserving the existing
application and domain modules:

```text
Slack -> API Gateway HTTP API -> ingress Lambda -> SQS FIFO
      -> worker Lambda -> PostgreSQL -> Step Functions Standard
```

- API Gateway exposes exactly the signed Slack webhook route.
- The ingress Lambda reconstructs the exact body, authenticates it, and waits
  only for SQS acceptance.
- SQS FIFO absorbs bursts and invokes the worker using an event-source mapping
  with partial-batch responses.
- The worker performs the database idempotency transition, then starts a
  deterministic Standard workflow execution.
- `ExecutionAlreadyExists` is success because an SQS retry can occur after the
  start request succeeded. Every other start error remains retryable.
- Step Functions currently contains only an honest `WorkflowAccepted` terminal
  state. States are added only with real, idempotent application-stage handlers.
- Local development retains Fastify, a polling SQS worker, PostgreSQL, and
  LocalStack; serverless adapters are delivery mechanisms, not a fork of domain
  logic.

## Consequences

### Benefits

- Ingress and worker capacity scale independently and idle compute cost is low.
- API Gateway removes the need for an always-running load balancer and web task.
- SQS provides durable backpressure between a public integration and downstream
  database/provider limits.
- Step Functions will provide durable retries, timers, execution history, and a
  future human-review wait without keeping a worker alive.
- Separate roles keep ingress unable to read the queue/database and keep the
  worker unable to accept public traffic.

### Costs and failure modes

- Cold starts and a Secrets Manager read are now in the Slack request path on a
  new execution environment. Slack retries mitigate transient misses, but do not
  make poor latency acceptable.
- Lambda concurrency can exhaust PostgreSQL even at modest request volume. RDS
  Proxy, a small connection pool, reserved concurrency, and an event-source
  maximum are required controls.
- A VPC-attached worker needs controlled access to Secrets Manager and Step
  Functions through interface endpoints or NAT. Omitting this produces timeouts,
  not a cheaper production system.
- AWS emulators do not prove IAM, API Gateway byte preservation, FIFO redelivery,
  or VPC behavior. A staging smoke/load test is required.
- Step Functions introduces another consistency boundary. Deterministic names
  close the known commit/start retry window, but future stage side effects still
  need idempotency keys or a transactional outbox.
- Standard workflows add per-transition cost. Express workflows are cheaper at
  high volume but are a poor fit for long, auditable, human-gated incident work.
- Lambda's maximum execution duration means long evidence processing must be
  split into bounded stages or moved to another compute adapter.

## Rejected alternatives

### Keep Fargate and an Application Load Balancer

Operationally conventional and suitable for sustained traffic, but it creates a
fixed idle bill and leaves durable human-wait orchestration to application code.
It remains a valid migration target if measured Lambda duration, VPC/NAT cost,
or workload shape makes serverless more expensive.

### Direct API Gateway to SQS

Cheaper and removes ingress compute, but Slack HMAC verification requires the
signing secret, exact bytes, timestamp validation, and application parsing. That
security boundary belongs in tested code, not a mapping template.

### Start Step Functions directly from ingress

This removes SQS but couples Slack acknowledgement to workflow availability and
loses the queue's explicit backpressure/DLQ boundary. It also starts orchestration
before database idempotency has resolved the durable incident identity.

### One Lambda per speculative future stage now

Rejected. Empty functions and decorative states create operational surface
without behavior. Add a stage when its input/output contract, retry policy,
idempotency boundary, and tests exist.

## Production gates

Before describing the AWS path as production-ready:

1. Provision private PostgreSQL/RDS Proxy networking and worker VPC attachment.
2. Provide interface endpoints or controlled NAT for the worker's AWS/external
   calls and verify DNS/TLS.
3. Run migrations as a separate release job, never from concurrent Lambdas.
4. Configure encrypted remote Terraform state and artifact promotion.
5. Route alarms and test DLQ diagnosis/redrive.
6. Measure signed-webhook latency, cold starts, database connections, duplicate
   delivery, and Step Functions start failures in staging.
7. Implement and test secret rotation behavior.

Until those gates pass, the repository contains a deployable foundation, not
evidence of a production deployment.
