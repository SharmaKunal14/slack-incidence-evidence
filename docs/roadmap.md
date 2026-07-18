# Product and engineering roadmap

Status: working plan  
Last updated: 2026-07-18

## Goal

Ship a production-quality vertical slice that demonstrates reliable Slack and GitHub integrations, structured AI extraction, evidence-backed claims, human review, and controlled external effects.

The project is successful when a real user can trigger an incident review from Slack, inspect the evidence behind every incident-specific claim, correct uncertainty, approve the result, and create durable follow-up work—with measurable reliability and AI-quality results.

It is not successful merely because an LLM can summarise a transcript.

## Status vocabulary

- **Implemented:** code and tests exist in the repository. This does not imply production deployment.
- **In progress:** a bounded production slice exists, but the stage's full exit
  criteria are not met.
- **Next:** the immediate vertical slice; design is sufficiently constrained to build.
- **Planned:** valuable after the preceding exit criteria are met.
- **Explore:** hypothesis requiring user evidence or measured scale.
- **Non-goal:** intentionally excluded from the current product.

## Implemented foundation

The current foundation establishes:

- a strict TypeScript single-package modular monolith;
- local Fastify/polling entrypoints plus production API Gateway/Lambda adapters;
- Slack signed-request and replay validation;
- URL-verification and `app_mention` command parsing;
- an initial `C`-prefixed Slack channel guard that ignores `G`/`D`/unknown prefixes;
- a strict Zod-validated, versioned SQS FIFO job contract;
- SQS producer/consumer adapters with at-least-once processing semantics and
  FIFO-safe Lambda partial batch responses;
- a tenant-scoped PostgreSQL incident repository with uniqueness and optimistic concurrency for idempotent work;
- an `IncidentAggregate` and explicit lifecycle state machine;
- tenant-keyed schemas for installations, incidents, source artifacts, timeline events, claims, claim-evidence links, workflow jobs, and audits, including cross-tenant composite foreign-key protection;
- checksum-verified, advisory-lock-protected SQL migrations;
- a vendor-neutral, Zod-validated AI-analysis contract and production OpenAI
  Responses adapter with strict structured output and no model tools;
- deterministic Step Functions Standard execution starts that close the
  database-commit/start retry window;
- workspace-bound Slack status replies with separate least-privilege bot-token
  access, bounded network calls, strict response validation, and a stable
  client message ID for retry safety;
- bounded triggering-thread retrieval with strict Slack response validation,
  stable permalinks, operational-message filtering, and provider rate-limit
  handling;
- transactional evidence upserts and optimistic page checkpoints so Lambda and
  Step Functions retries converge without duplicate artifacts;
- a Step Functions loop which keeps source content out of workflow state and
  delegates waits rather than billing a sleeping Lambda;
- versioned analysis runs, immutable input-manifest hashes, expiring database
  leases, bounded retry waits, and transactional persistence of cited timeline
  events, claims, contradictions, and open questions;
- explicit model/prompt/schema metadata and token usage without raw prompts or
  model output in operational logs or Step Functions state;
- Secrets Manager adapters and Zod-validated local/Lambda configuration plus
  strict runtime secret contracts;
- Terraform for API Gateway, Lambda, SQS FIFO/DLQ, the initial Standard workflow,
  scoped IAM, logs, concurrency controls, networking inputs, and queue alarms;
- liveness and readiness endpoints;
- structured, redacted Pino logging with raw request logging disabled;
- Docker/local Compose, CI, and unit-test foundations; and
- architecture and security documentation.

This foundation proves reliable ingestion, triggering-thread collection, and a
bounded structured extraction path. It does **not** yet claim complete channel
evidence coverage, enforced expiry deletion, production OAuth lifecycle
management, measured AI quality, report generation, review, or publication.

## Stage 1 — Deploy and prove the integration foundation

Status: **In progress**

### User outcome

A developer installs/configures the Slack app, triggers it in a supported public channel, and sees one durable job processed exactly once from the product's perspective.

### Scope

- Slack app manifest and installation instructions.
- Documented end-to-end local setup using the implemented Compose services.
- Replace the initial channel-ID-prefix guard with authorized Slack conversation metadata and installation policy before history collection.
- Production SQS FIFO and dead-letter queue configuration.
- Production worker retry, visibility-timeout, and terminal-failure policy.
- Extend CI from the implemented unit checks to integration, migration, container, and dependency-security tests.
- OpenTelemetry traces and core queue/job metrics.
- Provision the database/RDS Proxy/network layer consumed by the implemented
  serverless Terraform root.
- Add encrypted remote Terraform state and immutable artifact promotion.
- Execute real AWS staging smoke, redelivery, cold-start, and database-connection
  tests; local emulation is insufficient.

### Exit criteria

- Valid Slack requests are acknowledged within the required deadline under normal load.
- Altered, stale, and unsigned requests are rejected; `G`/`D`/unknown channel IDs cannot create a job.
- Replaying one event creates one durable job.
- Concurrent delivery cannot create duplicate job state.
- A worker crash results in safe redelivery.
- Dead-lettered work is visible and has a documented redrive process.
- Representative logs and traces contain no raw Slack content or secrets.
- A clean environment can be created from infrastructure and migration code.
- A Standard workflow execution exists exactly once per durable incident, even
  when the SQS delivery around `StartExecution` is retried.

### Main risks

- HTTP middleware may destroy the raw bytes required for signature verification.
- Local emulators may hide real SQS FIFO, IAM, or visibility-timeout behavior.
- Returning a Slack response before durable queue acceptance can lose jobs.
- Returning only after nonessential work can exceed acknowledgement deadlines.

## Stage 2 — Deterministic Slack evidence bundle

Status: **In progress**

### User outcome

From a message shortcut or mention, a user selects an incident time window and explicit public channels. The system produces a deterministic evidence bundle with source permalinks and a source-coverage manifest.

### Scope

- Slack OAuth installation and encrypted token storage.
- App mention and message-shortcut triggers.
- Incident-scoping modal: title, time window, primary channel, additional channels, reviewer.
- Triggering message and thread retrieval.
- Explicit selected-channel history retrieval.
- Authors, event/report timestamps, edit metadata, reactions, and permalinks.
- Normalised source artifact references.
- Optional evidence snapshots with explicit retention authority.
- Rate-limit compliance using provider retry hints and jitter.
- Partial-source failure representation.
- Source manifest listing searched, unavailable, and excluded sources.
- Deletion/uninstall/token-revocation handling.

### Implemented slice

- Mention-triggered root/thread retrieval for one configured workspace and one
  supported public channel.
- One 15-message page per Lambda invocation with a durable cursor, atomic
  artifact/checkpoint transaction, and Step Functions pagination loop.
- Stable `workspace + channel + message timestamp` artifact identity, content
  hash, author/source timestamps, selected edit metadata, and HTTPS Slack
  permalinks.
- Explicit Slack throttling waits, bounded transient retries, terminal safe
  failure codes, bounded collector concurrency, and workflow-failure alarm.
- A configurable retention deadline is recorded on each snapshot.

Still missing from this stage are OAuth installation/token lifecycle, trusted
conversation metadata authorization, the scoping modal, selected-channel time
windows, reactions, a coverage manifest, and the deletion job that enforces the
recorded retention deadline. A timestamp alone is not an enforced retention
policy.

### Non-scope

- DMs, group DMs, private channels, arbitrary workspace search, Slack Connect, or files.
- Semantic discovery.

### Exit criteria

- Recollection produces the same canonical artifacts without duplicates.
- Every artifact retains workspace, channel, source timestamp, author reference, and permalink.
- Event time and report time are not conflated.
- Inaccessible sources remain visible as unavailable rather than disappearing silently.
- Revoked credentials stop collection without losing the job's existing safe state.
- Raw evidence follows a documented retention and deletion policy.

### Main risks

- Slack API permissions and rate limits may make the selected retrieval path impractical.
- “Public channel” does not mean the content is safe to send to a model.
- Persisting content increases deletion, backup, and employee-access obligations.

## Stage 3 — GitHub evidence integration

Status: **Planned**

### User outcome

The incident evidence bundle includes factual change history from one explicitly selected GitHub repository.

### Scope

- GitHub App installation and webhook verification.
- Repository selection constrained to installed repositories.
- Read-only retrieval of commits, merged pull requests, deployments, releases, workflow runs, reverts, and linked issues in the incident window.
- Normalised GitHub source references and permalinks.
- Entity links between Slack deploy/PR/commit mentions and GitHub objects.
- Installation-token renewal and revocation handling.
- Connector-specific rate-limit, pagination, timeout, and partial-failure behavior.

Issue creation is intentionally deferred until the review and external-effect controls exist.

### Exit criteria

- The connector uses a GitHub App, not a developer's personal access token.
- Permissions are read-only and repository-scoped for collection.
- Stable source IDs prevent duplicate artifacts.
- A GitHub outage produces an explicitly partial Slack result.
- The demo can correlate a Slack rollback statement with a GitHub deployment or revert.

### Main risks

- A deployment may occur outside GitHub and create false absence.
- Temporal correlation is evidence, not proof of causation.
- Repository access can change after evidence is collected.

## Stage 4 — Structured AI extraction and evaluation

Status: **In progress**

### User outcome

The system turns the evidence bundle into an evidence-linked timeline, claims, contradictions, and open questions without silently inventing incident facts.

### Scope

- One approved model-provider adapter behind the existing AI ports.
- Bounded chunking and deterministic input manifests.
- Schema-constrained extraction of observations, participant assertions, hypotheses, decisions, mitigation actions, outcomes, impact, and follow-ups.
- Canonical entity and duplicate consolidation.
- Explicit claim classifications:
  - directly observed;
  - corroborated;
  - participant assertion;
  - hypothesis;
  - correlated inference;
  - disputed;
  - unknown; and
  - human confirmed.
- Supporting and contradicting evidence links.
- Report-section generation from structured claims, not raw transcripts.
- Claim-support and causal-overstatement validation.
- Prompt, schema, model, latency, token, and cost metadata.
- Evaluation harness and labelled synthetic/anonymised incident corpus.
- Prompt-injection, secret-leakage, malformed-output, and truncation tests.

### Implemented slice

- A dedicated analysis Lambda invoked after durable Slack collection, with raw
  content kept out of Step Functions state.
- A deterministic, character- and artifact-bounded evidence manifest and SHA-256
  identity.
- An OpenAI Responses adapter behind a provider-neutral port, using strict JSON
  Schema output, `store: false`, no tools, a fixed endpoint, bounded response
  reads, an explicit model, request timeout, and output-token limit.
- Validation that citations reference tenant-scoped source artifacts, model keys
  and citations are unique, non-hypothetical factual claims have support, and
  only humans may use `HUMAN_CONFIRMED`.
- A durable versioned run with an expiring lease, bounded explicit retries,
  terminal handling for ambiguous network outcomes, and idempotent completed
  invocations.
- One database transaction for timeline events, all timeline citations,
  unreviewed claims, supporting/contradicting evidence links, open questions,
  provider metadata, token usage, and run completion.
- Lifecycle progression through `NORMALIZING`, `EXTRACTING`, and `GENERATING`,
  or to terminal `FAILED` on a durable analysis failure.

Still missing are chunked analysis for evidence beyond the hard input budget,
cross-source entity consolidation, report-section generation, a labelled
evaluation corpus and quality/cost dashboard, provider data-processing approval,
and human review. Passing a JSON schema is not evidence that the extracted facts
are correct.

### Exit criteria

- Every incident-specific factual sentence maps to one or more claim IDs.
- Every claim presented as supported has inspectable evidence links.
- Invalid model responses are retried within budget or quarantined; they are not accepted opportunistically.
- Hypotheses are not rewritten as confirmed causes.
- The report exposes contradictions and unknowns.
- Evaluation reports define their corpus and metrics rather than claiming undefined “accuracy.”
- Cost and latency per incident are measured.

### Initial evaluation metrics

- important-event precision and recall;
- timeline ordering accuracy;
- citation coverage;
- evidence-entailment accuracy;
- unsupported-claim rate;
- causal-overstatement rate;
- contradiction recall;
- sensitive-data leakage rate;
- latency and provider cost; and
- later, reviewer edit distance and review time.

Targets must be set after baseline evaluation. Inventing impressive percentages would weaken the project.

### Main risks

- The evidence set may be incomplete even when the output is fluent.
- Model-generated numeric confidence is uncalibrated and must not be presented as truth.
- Prompt injection cannot be solved by prompt wording alone.
- Evidence support can establish consistency or correlation, not objective causality.

## Stage 5 — Evidence review console

Status: **Planned**

### User outcome

A reviewer can inspect and correct the incident without reading an opaque generated document or touching the database.

### Scope

- Authenticated web review experience.
- Timeline, claims/draft, and supporting-evidence panes.
- Accept, reject, edit, dispute, and reclassify a claim.
- Correct event timestamps.
- Open original Slack and GitHub sources.
- Answer open questions.
- Exclude sensitive evidence.
- Immutable human decision records.
- Draft revision history.
- Source-access revalidation.
- Slack notification when a draft is ready.

### Exit criteria

- Model output cannot create a human decision record.
- Every review read and mutation is tenant scoped.
- A reviewer can complete the workflow without developer tools.
- A claim correction produces a new revision and preserves audit history.
- No external publication exists yet without an approved draft version.
- Real reviewers report lower effort than the manual baseline.

### Main risks

- A generic document editor would consume time without strengthening evidence review.
- Reviewers may mechanically approve fluent drafts.
- Browser authorization bugs can defeat otherwise correct source permissions.

## Stage 6 — Controlled publication and follow-up actions

Status: **Planned**

### User outcome

After human approval, the system publishes one source-linked Markdown report and creates approved follow-up work as GitHub issues.

### Scope

- Approved-draft publication state machine.
- Markdown renderer and one controlled destination.
- Slack completion message linking to the reviewed artifact.
- GitHub issue creation with description, owner, priority, due date, linked claim/failure mode, verification method, and incident link.
- Transactional outbox.
- Stable external idempotency keys.
- Ambiguous-timeout reconciliation.
- Destination allowlist and audience policy.
- External resource IDs and audit records.

### Exit criteria

- An unreviewed or superseded draft cannot be published.
- A worker retry cannot create a second document or issue.
- Unknown destination visibility blocks automatic publication.
- Publication records the exact approved revision and source set.
- Revoked destination permission produces a clear recoverable state.
- A complete demonstration runs Slack trigger to reviewed report to GitHub follow-up issue.

### Main risks

- Publishing creates a new copy with separate retention and access semantics.
- An external timeout can leave the effect completed but locally unknown.
- Issue creation without owner commitment can become action-item theatre.

## Stage 7 — Hardening and design-partner validation

Status: **Planned**

### User outcome

Two or three real teams can use the system on real incidents, and the project has credible quality, reliability, security, and cost evidence.

### Scope

- Multi-tenant isolation and negative authorization suite.
- Row-level database defence in depth.
- Tenant quotas and per-workspace concurrency.
- Operational dashboards and alerts.
- Backup restore and dead-letter redrive exercises.
- Token rotation and uninstall runbooks.
- Threat-model review and external security feedback.
- Load and failure-injection tests.
- Cost budgets and provider kill switch.
- Fifteen to thirty curated incident fixtures.
- Five-minute reproducible incident demonstration.
- Architecture case study and honest known-limitations document.

### Exit criteria

- At least two external teams complete real review workflows.
- No source permission violation is observed; any violation is a release blocker, not a tolerated metric.
- Median reviewer time and edit distance are measured against a manual baseline.
- Job success, latency, cost, retrieval, citation, and unsupported-claim metrics are published with definitions.
- Recovery and revocation procedures are exercised, not merely documented.

## Later product capabilities

Status: **Explore after validated usage**

- PagerDuty or Opsgenie incident context.
- Datadog or Grafana evidence.
- Private-channel contribution with explicit authorization and audience handling.
- Related-channel discovery under Slack's current storage and search constraints.
- Service catalogue and entity resolution.
- Belief-evolution timeline showing what responders knew at each moment.
- Similar-incident retrieval.
- Previously incomplete corrective-action detection.
- Action completion verification.
- Recurrence and organisational-learning analysis.
- Multiple report templates and destinations.
- Enterprise controls such as SSO, regional processing, and customer-managed keys.

Each connector changes the threat model, permission graph, retention behavior, and evaluation surface. Connector count is not itself a success metric.

## Explicit non-goals for the resume project

- Pager or on-call replacement.
- Status-page management.
- Autonomous production remediation.
- Unrestricted private-channel or DM ingestion.
- General enterprise search.
- Slack Marketplace submission before the product is validated.
- Multi-region active-active deployment.
- A custom vector or graph database.
- Kubernetes, Kafka, or a workflow engine without measured need.
- Five shallow document and issue-tracker integrations.
- AI-generated root cause without human confirmation.

## Delivery slices

Prefer demonstrable vertical slices over layers that remain unconnected for months:

1. **Reliable trigger:** signed Slack event to one PostgreSQL job.
2. **Inspectable evidence:** explicit Slack thread/channel selection to source manifest.
3. **Cross-system fact:** GitHub deployment or revert linked to Slack evidence.
4. **Trustworthy draft:** structured claims and cited timeline with evaluation results.
5. **Human control:** reviewer corrects and approves a version.
6. **Safe effect:** one Markdown artifact and one idempotent GitHub follow-up issue.

Every slice should include tests, metrics, failure behavior, a short demo, and documentation.

## Resume-quality evidence to collect

The final project should be able to support statements such as:

- number of real or labelled incidents processed;
- number of Slack messages and GitHub artifacts evaluated;
- important-event precision and recall;
- citation coverage and unsupported-claim rate;
- median generation and review time;
- average model cost per incident;
- duplicate events suppressed;
- recovery behavior under injected failures; and
- measured reduction in human review effort.

Do not claim a metric until its denominator, corpus, measurement process, and limitations are documented.

## Decision gates

Before adding a feature, answer:

1. Does it improve evidence completeness, trust, user review effort, or operational reliability?
2. Can its permission and retention behavior be stated precisely?
3. Is there a real incident fixture or design-partner need that exercises it?
4. Can it be observed and evaluated?
5. Does the existing architecture fail a measured requirement without it?

If the answer is no, keep the feature out of the current build.
