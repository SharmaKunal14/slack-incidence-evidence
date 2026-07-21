## Inspiration

The incident was over, but the truth was not ready.

When production breaks, engineers are focused on restoring service—not writing a perfect history. The real story ends up scattered across Slack: observations mixed with guesses, decisions buried between status updates, contradictory accounts, timestamps without context, and important questions nobody had time to answer. Days later, someone has to reconstruct all of it from memory and turn it into a postmortem.

AI can remove the blank page, but it introduces a more dangerous failure mode: a fluent report that sounds authoritative even when the evidence is incomplete. Once that report enters a knowledge base, a plausible guess can become institutional memory.

That inspired **OnRecord**: not an AI that decides what happened, but an evidence and approval layer for production incidents. Its promise is simple: **put every incident on the record—and make every conclusion traceable to why the team believes it.**

## What it does

OnRecord turns fragmented Slack incident conversations into an evidence-linked postmortem that a human can verify, revise, approve, and publish.

An engineer starts the workflow from Slack and scopes the incident: a bounded time window, one primary public channel, up to four additional public channels, optional anchors for threads outside the window, and a reviewer. OnRecord automatically expands in-window threads, merges them with those anchors, collects the evidence with durable checkpoints, and creates an explicit coverage manifest, so an inaccessible or incomplete source remains visible instead of silently disappearing.

GPT-5.6, accessed through the OpenAI Responses API, first transforms the collected evidence into a structured incident record:

- a cited timeline;
- claims classified as observations, participant assertions, hypotheses, correlated inferences, disputed statements, or unknowns;
- supporting and contradicting evidence links; and
- unanswered questions.

A second evidence-constrained generation stage creates the postmortem draft from that structured record—not directly from raw Slack text. Every incident-specific statement must point to a known claim or timeline event, and the application rejects fabricated evidence references or attempts to make a statement more certain than its sources.

The reviewer then opens the OnRecord console and can inspect each statement beside the original evidence, keep it, edit it, exclude it, change its classification, answer open questions, and explicitly acknowledge contradictions. Every correction produces an immutable revision. Only an authenticated human can approve the final record, after which OnRecord publishes the exact approved revision to Confluence or Notion and posts the final link back to Slack.

The model can draft. It cannot approve, publish, or silently rewrite history.

## How we built it

OnRecord is a strict TypeScript application organized around domain and application boundaries, with provider-specific behavior behind ports and adapters. The same core use cases support local Fastify workers and a serverless AWS runtime.

The production path uses API Gateway, Lambda, SQS FIFO, Step Functions, PostgreSQL, Cognito, S3, and CloudFront. Slack requests are authenticated before parsing, acknowledged only after durable queue acceptance, and processed with database-backed idempotency. Evidence collection is paginated and checkpointed, while Slack-directed rate-limit waits are handled by Step Functions rather than a sleeping Lambda.

The AI pipeline uses the OpenAI Responses API with strict structured output, explicit model and token budgets, `store: false`, no model tools, and application-level validation after generation. Source IDs are treated as capabilities: a model cannot cite evidence that is not present in the incident's tenant-scoped manifest. Operational logs and workflow state contain identifiers and bounded counters, not raw Slack messages, prompts, or generated reports.

The review experience is built with React, TanStack Query, Radix UI, and a Cognito authorization-code flow with PKCE. PostgreSQL preserves the evidence graph, immutable revisions, approval audit trail, and a transactional publication outbox so retries cannot create duplicate external pages.

Codex was my engineering partner throughout Build Week. I used it to explore architecture tradeoffs, turn security and reliability requirements into testable invariants, implement vertical slices across the Slack, AI, database, AWS, and React boundaries, diagnose integration and UI failures, and iterate on the final product experience. The important decisions—evidence before prose, explicit uncertainty, fail-closed permissions, human approval, and no autonomous external effects—were made deliberately; Codex helped carry those decisions consistently through a large, working codebase.

Rather than asking Codex for one giant generated project, I worked in bounded loops: inspect the current system, challenge an assumption, implement one coherent slice, test its failure modes, and then integrate it into the end-to-end workflow.

## Challenges we ran into

The hardest challenge was defining what “evidence-backed” actually means. Structured output alone is not trustworthy. We needed domain rules that reject unknown citations, require support for factual claims, preserve contradicting evidence, prevent a writing stage from upgrading uncertainty, and reserve human confirmation for a real reviewer.

Slack also imposed non-obvious reliability constraints. Signed requests must be verified against the exact raw bytes, yet Slack expects a fast response. Collection is paginated and rate-limited, and both Slack events and queue delivery can be repeated. That required separating acknowledgement from processing and designing every step for safe redelivery instead of pretending execution happens exactly once.

Partial evidence was another difficult product problem. A polished report can hide the fact that a channel was inaccessible or collection failed halfway through. OnRecord therefore stores source-level outcomes and carries the coverage warning into both the report and the review console.

The review interface had to show a dense relationship between report statements, claims, timeline events, questions, source coverage, and original Slack evidence without becoming an unreadable forensic dashboard. Several iterations were spent fixing focus behavior, scrolling, evidence highlighting, version navigation, and the question-review experience.

Finally, external publication had to remain safe under retries. Approval writes to a transactional outbox, and the publication worker uses leases and provider-neutral checkpoints so an ambiguous timeout does not casually create duplicate Confluence or Notion pages.

## Accomplishments that we're proud of

I am most proud that OnRecord is not a one-prompt transcript summarizer. It is a complete, evidence-first workflow from Slack trigger to human-approved publication.

The system now supports multi-channel incident scoping, durable evidence collection, structured extraction, an evidence-constrained report, contradiction and unknown preservation, a source-linked review console, immutable revisions, human approval, configurable Confluence or Notion publication, and a final Slack notification.

The model has no authority to approve content or create external effects. Every generative boundary is schema-constrained and followed by application validation. Every review mutation is tenant-scoped. Every approved record is tied to the exact revision and evidence graph that produced it.

The repository currently passes **236 tests across 61 test files**, along with strict TypeScript checks, linting, deterministic builds, Lambda packaging, frontend production builds, migration checks, infrastructure-policy tests, and a ten-incident offline safety evaluation. The evaluation deliberately reports structural safety metrics rather than pretending a synthetic corpus proves factual accuracy.

Most importantly, the finished product has a coherent experience and a clear point of view: AI should remove reconstruction toil without removing human judgment.

## What we learned

I learned that trustworthy AI is as much a persistence and permissions problem as it is a prompting problem. The decisive work happens outside the model: deciding which evidence is in scope, recording what was unavailable, validating citations, preserving provenance, controlling state transitions, and making unsafe external effects impossible.

I also learned that citations are necessary but not sufficient. A citation can be real while failing to support the sentence attached to it. That is why OnRecord distinguishes direct observations, assertions, hypotheses, correlation, disputes, and unknowns rather than collapsing everything into a generic confidence score.

Human-in-the-loop only matters when the human has meaningful control. A decorative “approve” button would not be enough. Reviewers need to see the source, challenge the classification, remove a statement, answer an open question, and leave behind an immutable record of what changed.

Working with Codex reinforced the value of explicit constraints. It performed best when the task was framed as an invariant—such as “a model-generated source ID must already exist in this tenant's manifest”—and accompanied by a failure test. That made it possible to move quickly without treating generated code as automatically correct.

## What's next for OnRecord

The next milestone is not more architecture; it is validation with real teams. I want to run OnRecord with a small group of design partners and measure whether it increases the percentage of incidents that reach an approved record, reduces reviewer effort, and produces reports that engineers trust.

The immediate product roadmap includes Slack OAuth and token lifecycle management, enforceable evidence deletion, permission-aware private-channel support, destination audience checks, and source-access revalidation during review.

The next evidence integration will be a read-only GitHub App for commits, pull requests, deployments, workflow runs, and reverts. That will let OnRecord compare what responders said in Slack with operational change history rather than treating conversation as the whole truth.

For larger incidents, I plan to add chunked evidence analysis and cross-source entity consolidation. I also want to build a human-labelled evaluation set that measures citation entailment, important-event recall, contradiction recall, reviewer edit distance, review time, latency, and cost per approved incident.

Longer term, OnRecord can become the trusted incident memory for an engineering organization: connecting evidence across deployments, alerts, conversations, and past incidents while preserving how each conclusion was reached.

**Put every incident on the record.**
