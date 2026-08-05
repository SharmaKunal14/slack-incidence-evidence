# ADR 0003: Use invite-only Slack OAuth onboarding with tenant-scoped credentials

- Status: accepted
- Date: 2026-08-05
- Decision owners: project maintainers
- Extends: ADR 0001 and ADR 0002

## Context

OnRecord currently supports one preconfigured Slack workspace per deployment.
Every Slack-capable Lambda loads the same workspace ID and bot token from one
Secrets Manager secret, a valid signed incident event can bootstrap its tenant,
and reviewer access requires an operator-created Cognito user plus a manual SQL
membership. The initial schema contains a `slack_installations` table, but no
application service reads or writes it.

Adding an OAuth callback without changing those boundaries would be unsafe. It
would obtain credentials that the runtime cannot select per workspace, would
leave installation unrelated to tenant authorization, and would not connect a
Slack-selected reviewer to a Cognito identity.

The first onboarding release is intended for a small number of invited design
partners. It does not need Slack Marketplace discovery, unauthenticated public
signup, Enterprise Grid organization-wide installation, GovSlack, private
channels, or self-service publication-destination OAuth.

## Decision

Use one shared OnRecord Slack app installed into invited customer workspaces
through Slack OAuth V2. An existing Cognito-authenticated OnRecord user begins
the flow. Successful installation creates or updates the workspace tenant,
stores a tenant-scoped credential outside PostgreSQL, and establishes the first
administrator only when the tenant is new.

```text
Cognito-authenticated administrator
  -> one-time OnRecord authorization state
  -> Slack OAuth approval
  -> server-to-server code exchange
  -> tenant-scoped Secrets Manager credential
  -> PostgreSQL installation metadata and membership
```

### Product boundary

- The release is invite-only. An operator invites the first Cognito user.
- One Slack workspace maps to one OnRecord tenant, and the Slack team ID remains
  the tenant ID.
- The client approves access in Slack but never handles an access token, refresh
  token, client secret, signing secret, AWS credential, or database credential.
- The installer becomes the first tenant `ADMIN` only when installing a new
  workspace.
- Reinstalling an existing workspace requires an active OnRecord tenant
  `ADMIN`. Slack installation authority alone cannot take over an existing
  OnRecord tenant.
- Tenant-specific Notion or Confluence onboarding is a later decision. Approval
  may exist without publication, but one tenant must never inherit a deployment-
  global destination belonging to another tenant.

### Application credentials and installation credentials

The Slack app client ID, client secret, and signing secret belong to OnRecord:

- the client secret is readable only by OAuth and rotation components;
- the signing secret is readable only by signed Slack ingress components; and
- the public client ID may be included in an application-owned authorization
  URL.

Each Slack installation receives its own bot access token and, after token
rotation is enabled, refresh token and expiry. The credential is stored as one
strictly validated secret in Secrets Manager. PostgreSQL stores only its ARN,
safe Slack identifiers, granted scopes, status, expiry metadata, leases, and
audit timestamps.

Runtime Slack adapters resolve a credential using the operation's workspace ID.
They must verify that the installation is active and that the credential is
bound to the same workspace before making a Slack API request. There is no
fallback to another workspace or to a deployment-global credential.

Secrets Manager per installation is deliberately chosen for the design-partner
release because it reuses the existing secret boundary and avoids implementing
cryptography. Its per-secret cost is acceptable at this scale. Database
envelope encryption may be reconsidered if measured workspace scale makes that
cost material.

### Required Slack bot scopes

The application owns one canonical, least-privilege bot-scope list:

- `app_mentions:read`
- `channels:history`
- `channels:read`
- `chat:write`
- `commands`
- `users:read`

The app manifest must match this list. A test fails if the two drift. Adding a
scope requires an explicit contract and threat-model review because Slack OAuth
grants are additive and existing installations may require reauthorization.

### OAuth authorization state

Before redirecting to Slack, OnRecord creates a high-entropy authorization
state whose plaintext is returned only to the initiating browser. PostgreSQL
stores its SHA-256 hash, the initiating Cognito subject, a browser-binding hash,
the exact redirect URI, requested scopes, status, and expiry.

The state:

- expires after ten minutes;
- is single-use;
- is compared without logging its plaintext;
- is bound to the initiating browser and Cognito subject; and
- cannot be reused to change the target tenant after Slack returns.

The callback remains publicly reachable because Slack redirects the browser to
it, but completing an installation requires the valid state and browser
binding. Authorization codes and tokens never appear in logs or user-facing
errors.

### Installation lifecycle

Installation status has five values:

- `PENDING`: an explicit installation or reinstall is being completed;
- `ACTIVE`: runtime Slack operations may resolve the credential;
- `RECONNECT_REQUIRED`: the credential is expired, invalid, or cannot be safely
  refreshed; runtime Slack operations fail closed;
- `REVOKED`: Slack or an OnRecord administrator removed the installation; and
- `FAILED`: setup did not create a usable installation.

Legal state transitions are:

```text
PENDING -> ACTIVE | FAILED
ACTIVE -> RECONNECT_REQUIRED | REVOKED
RECONNECT_REQUIRED -> ACTIVE | REVOKED
FAILED -> PENDING | REVOKED
REVOKED -> PENDING
```

Updating an `ACTIVE` installation during an authorized reinstall is an
idempotent credential replacement, not a state transition. A revoked workspace
must begin a new explicit reinstall and pass through `PENDING` before becoming
active again.

### Reinstall, expiry, and revocation rules

**Reinstall:** preserve the tenant, incidents, approved records, memberships,
and audit history. Replace the credential only after the new OAuth response,
required scopes, app identity, workspace identity, and `auth.test` result are
validated. A non-admin cannot claim an existing tenant by reinstalling its Slack
app.

**Expiry:** an `ACTIVE` status does not make an expired rotating credential
usable. Runtime resolution checks expiry and fails closed. The rotation worker
is the only runtime allowed to use refresh credentials. Terminal or ambiguous
refresh failure moves the installation to `RECONNECT_REQUIRED`; ordinary Slack
operations never attempt an opportunistic refresh.

**Slack uninstall or token revocation:** mark the installation unusable
idempotently even if lifecycle events arrive more than once or out of order.
Block new incidents and Slack-dependent retries, preserve safe audit metadata,
and handle existing evidence under the configured retention policy. Credential
deletion is a separate, retryable cleanup operation and cannot restore runtime
authority.

**OnRecord disconnect:** require a tenant `ADMIN`, explicit confirmation, and an
idempotency key. Mark the installation revoked before attempting any external
token revocation so an ambiguous Slack response cannot leave local authority
enabled.

### Reviewer identity

The initiating Cognito subject is mapped to the Slack `authed_user.id` returned
by OAuth when the tenant is first created. Later reviewer invitations bind one
Cognito subject to one Slack user ID within the tenant.

- `ADMIN` members may review every tenant incident.
- `REVIEWER` members may review only incidents assigned to their mapped Slack
  user.
- Selecting an unmapped or revoked reviewer in Slack is rejected before work is
  accepted.
- Email equality is not used as proof of Slack identity; the release does not
  request `users:read.email`.

### Serverless boundaries

Use separate deployment and IAM boundaries:

- an authenticated onboarding API Lambda starts OAuth and exposes safe status;
- its public callback validates and completes the one-time authorization;
- existing signed Slack ingress continues to authenticate Slack requests;
- an EventBridge-scheduled rotation Lambda owns refresh operations; and
- incident workers, collectors, analysis identity resolution, notifiers, and
  publishers receive only tenant-scoped credential-read authority.

OAuth remains a bounded synchronous API flow. Incident processing remains on
the existing SQS and Step Functions path. Lambda handlers stay thin and call
application services; OAuth and credential logic do not move into Terraform or
API Gateway mappings.

### Token rotation activation

Rotation support is implemented and proven with a cloned staging Slack app
before the irreversible Slack setting is enabled in production. The staging
gate requires multiple successful refresh cycles plus injected retries and
Secrets Manager/database failures.

The production setting is enabled only after:

1. the scheduled worker, alarms, reconnect flow, and emergency kill switch are
   deployed;
2. the current static workspace is represented as an installation;
3. its long-lived token has a tested migration path; and
4. database-backed credential resolution is active.

### Observability and data handling

Logs and metrics may contain correlation IDs, hashed workspace identifiers,
installation status, safe error codes, duration, and counts. They must not
contain authorization codes, OAuth state plaintext, browser-binding values,
access tokens, refresh tokens, provider response bodies, or secret values.

Minimum onboarding signals are starts, completions, failures by safe code,
active installations, refresh success/failure, credentials nearing expiry, and
reconnect-required installations. Alarms cover Lambda errors and throttles,
duration near timeout, failed scheduled invocations, and overdue rotation.

## Consequences

### Positive

- Clients never exchange secrets manually.
- Installation becomes the explicit workspace authorization boundary.
- Tenant-scoped credential resolution prevents cross-workspace token reuse.
- Cognito authentication, tenant memberships, and existing application ports
  remain useful.
- Reinstall, revocation, expiry, and partial failure have defined outcomes
  before side-effecting code is added.
- Separate Lambdas permit narrow IAM and independent operational controls.

### Negative

- OAuth completion spans Slack, Secrets Manager, and PostgreSQL without a
  distributed transaction. Deterministic secret identity, idempotent state, and
  reconciliation are required.
- Secrets Manager per installation has a recurring per-workspace cost.
- Credential resolution adds database and secret-read latency to Slack API
  operations. Bounded caching may be added only after correctness is measured.
- Reviewer invitation still depends on an initial operator-created Cognito
  account in the invite-only release.
- Token rotation has an unavoidable ambiguous window if Slack issues a new
  single-use refresh token and the process fails before durable storage.

## Alternatives considered

### Ask each client to create its own Slack app

Rejected. It would require clients to configure endpoints and send OnRecord
their client secret and signing secret, multiplying operational and credential
risk.

### Store all bot tokens in one deployment secret

Rejected. Updating one shared document creates contention, broadens every
reader's credential access, and makes tenant isolation harder to audit.

### Store plaintext or application-encrypted tokens directly in PostgreSQL

Rejected for the design-partner release. Plaintext is unacceptable, while
application-managed envelope encryption adds key and cryptographic lifecycle
work that is not justified at the initial workspace count.

### Replace Cognito with Sign in with Slack

Rejected for this release. It would expand the authentication rewrite and mix
workspace installation with reviewer sign-in. Slack also treats Sign in with
Slack scopes as a separate authorization flow from ordinary app scopes.

### Refresh tokens inside ordinary Slack adapters

Rejected. It would give every Slack-calling Lambda the OAuth client secret,
create concurrent single-use refresh races, and make normal operations mutate
installation authority.

## Implementation and rollout rules

- Database migrations remain forward-only and backward compatible during the
  deployment window.
- The legacy static workspace path may exist behind an explicit staging
  migration mode, but production cannot silently fall back to it.
- New OAuth UI remains hidden until database-backed credential resolution works
  for the existing workspace.
- Disabling new installation starts is the safe rollback for OAuth failures;
  existing active installations must continue to operate.
- Rotation reserved concurrency `0` is an emergency stop, not a stable mode,
  because credentials will otherwise expire.
- Tenant-specific publication onboarding requires a separate decision and is
  not implied by Slack connection success.

## When to revisit

Revisit this decision when:

- public self-service or Slack Marketplace distribution is required;
- Enterprise Grid organization-wide installation or GovSlack is required;
- measured Secrets Manager cost justifies database envelope encryption;
- a workspace must belong to an organization containing multiple tenants;
- customer SSO or SCIM replaces invite-only Cognito administration; or
- destination OAuth and audience comparison are ready for their own design.
