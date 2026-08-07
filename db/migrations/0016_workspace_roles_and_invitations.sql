-- Adds explicit workspace roles, identity-bound invitations, and durable
-- incident assignment. Invitation acceptance requires a separate Slack OIDC
-- flow; email addresses are delivery metadata and never authorize membership.
-- This migration is forward-only after invitations or assignments are used.

ALTER TABLE reviewer_memberships
    DROP CONSTRAINT reviewer_memberships_role_check,
    ADD CONSTRAINT reviewer_memberships_role_check
        CHECK (role IN ('OWNER', 'ADMIN', 'REVIEWER', 'VIEWER'));

-- Preserve current access while establishing one initial owner per tenant.
WITH preferred_owner AS (
    SELECT DISTINCT ON (membership.tenant_id)
        membership.tenant_id,
        membership.cognito_subject
    FROM reviewer_memberships membership
    LEFT JOIN slack_installations installation
      ON installation.tenant_id = membership.tenant_id
     AND installation.installed_by_cognito_subject = membership.cognito_subject
    WHERE membership.role = 'ADMIN'
      AND membership.status = 'ACTIVE'
    ORDER BY membership.tenant_id,
             (installation.installed_by_cognito_subject IS NOT NULL) DESC,
             membership.created_at,
             membership.cognito_subject
)
UPDATE reviewer_memberships membership
SET role = 'OWNER', updated_at = statement_timestamp()
FROM preferred_owner owner
WHERE membership.tenant_id = owner.tenant_id
  AND membership.cognito_subject = owner.cognito_subject;

CREATE TABLE workspace_invitations (
    id UUID PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    invited_slack_user_id TEXT NOT NULL
        CHECK (invited_slack_user_id ~ '^[UW][A-Z0-9]{1,63}$'),
    delivery_email TEXT NOT NULL
        CHECK (char_length(delivery_email) BETWEEN 3 AND 320),
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'REVIEWER', 'VIEWER')),
    token_sha256 CHAR(64) NOT NULL UNIQUE
        CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')),
    invited_by_subject TEXT NOT NULL,
    accepted_by_subject TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    CONSTRAINT workspace_invitations_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    CONSTRAINT workspace_invitations_inviter_fk
        FOREIGN KEY (tenant_id, invited_by_subject)
        REFERENCES reviewer_memberships(tenant_id, cognito_subject)
        ON DELETE RESTRICT,
    CONSTRAINT workspace_invitations_acceptor_fk
        FOREIGN KEY (tenant_id, accepted_by_subject)
        REFERENCES reviewer_memberships(tenant_id, cognito_subject)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT workspace_invitations_time_valid CHECK (
        expires_at > created_at AND expires_at <= created_at + INTERVAL '7 days'
        AND updated_at >= created_at
    ),
    CONSTRAINT workspace_invitations_state_consistent CHECK (
        (status = 'PENDING' AND accepted_by_subject IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
        OR (status = 'ACCEPTED' AND accepted_by_subject IS NOT NULL AND accepted_at IS NOT NULL AND revoked_at IS NULL)
        OR (status = 'REVOKED' AND accepted_by_subject IS NULL AND accepted_at IS NULL AND revoked_at IS NOT NULL)
        OR (status = 'EXPIRED' AND accepted_by_subject IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
    )
);

CREATE UNIQUE INDEX workspace_invitations_pending_identity_idx
    ON workspace_invitations (tenant_id, invited_slack_user_id)
    WHERE status = 'PENDING';
CREATE INDEX workspace_invitations_tenant_created_idx
    ON workspace_invitations (tenant_id, created_at DESC);

CREATE TABLE slack_identity_authorizations (
    id UUID PRIMARY KEY,
    invitation_id UUID NOT NULL,
    cognito_subject TEXT NOT NULL
        CHECK (char_length(cognito_subject) BETWEEN 1 AND 128),
    state_sha256 CHAR(64) NOT NULL UNIQUE
        CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
    browser_binding_sha256 CHAR(64) NOT NULL
        CHECK (browser_binding_sha256 ~ '^[0-9a-f]{64}$'),
    nonce_sha256 CHAR(64) NOT NULL
        CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
    redirect_uri TEXT NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 2048),
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'CONSUMED', 'COMPLETED', 'FAILED')),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    failure_code TEXT CHECK (
        failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
    ),
    CONSTRAINT slack_identity_authorizations_invitation_fk
        FOREIGN KEY (invitation_id) REFERENCES workspace_invitations(id) ON DELETE RESTRICT,
    CONSTRAINT slack_identity_authorizations_time_valid CHECK (
        expires_at > created_at AND expires_at <= created_at + INTERVAL '10 minutes'
        AND (consumed_at IS NULL OR consumed_at >= created_at)
        AND (completed_at IS NULL OR completed_at >= consumed_at)
        AND (failed_at IS NULL OR failed_at >= consumed_at)
    )
);

CREATE INDEX slack_identity_authorizations_invitation_idx
    ON slack_identity_authorizations (invitation_id, created_at DESC);

ALTER TABLE incidents
    ADD COLUMN assigned_reviewer_subject TEXT;

UPDATE incidents incident
SET assigned_reviewer_subject = membership.cognito_subject
FROM reviewer_memberships membership
WHERE membership.tenant_id = incident.tenant_id
  AND membership.slack_user_id = incident.reviewer_user_id
  AND membership.status = 'ACTIVE'
  AND membership.role IN ('OWNER', 'ADMIN', 'REVIEWER');

ALTER TABLE incidents
    ADD CONSTRAINT incidents_assigned_reviewer_fk
        FOREIGN KEY (tenant_id, assigned_reviewer_subject)
        REFERENCES reviewer_memberships(tenant_id, cognito_subject)
        ON DELETE RESTRICT;

CREATE INDEX incidents_assigned_reviewer_idx
    ON incidents (tenant_id, assigned_reviewer_subject, created_at DESC)
    WHERE assigned_reviewer_subject IS NOT NULL;
