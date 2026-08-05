-- Stage 1 of Slack OAuth onboarding adds only persistence foundations.
-- OAuth credentials remain in Secrets Manager; PostgreSQL stores a reference
-- and safe provider metadata. Existing ciphertext-backed rows fail closed until
-- they are explicitly migrated by a later rollout stage.
--
-- Rollback outline (only before OAuth onboarding is used):
--   DROP TABLE slack_oauth_authorizations;
--   DROP INDEX reviewer_memberships_tenant_slack_user_unique;
--   ALTER TABLE reviewer_memberships DROP COLUMN slack_user_id;
--   ALTER TABLE slack_installations DROP added constraints and columns;
--   ALTER TABLE slack_installations ALTER COLUMN bot_token_ciphertext SET NOT NULL;
--   ALTER TABLE slack_installations ALTER COLUMN encryption_key_id SET NOT NULL;
-- A rollback after installations are onboarded would discard authorization and
-- credential-location metadata and therefore requires an explicit data migration.

ALTER TABLE slack_installations
    ALTER COLUMN bot_token_ciphertext DROP NOT NULL,
    ALTER COLUMN encryption_key_id DROP NOT NULL,
    ADD COLUMN status TEXT NOT NULL DEFAULT 'RECONNECT_REQUIRED',
    ADD COLUMN credential_secret_arn TEXT,
    ADD COLUMN credential_expires_at TIMESTAMPTZ,
    ADD COLUMN installed_by_cognito_subject TEXT,
    ADD COLUMN last_error_code TEXT,
    ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

UPDATE slack_installations
SET status = 'REVOKED'
WHERE revoked_at IS NOT NULL;

ALTER TABLE slack_installations
    ADD CONSTRAINT slack_installations_status_valid CHECK (
        status IN ('PENDING', 'ACTIVE', 'RECONNECT_REQUIRED', 'REVOKED', 'FAILED')
    ),
    ADD CONSTRAINT slack_installations_credential_location_valid CHECK (
        (
            bot_token_ciphertext IS NULL
            AND encryption_key_id IS NULL
        )
        OR (
            bot_token_ciphertext IS NOT NULL
            AND encryption_key_id IS NOT NULL
            AND credential_secret_arn IS NULL
        )
    ),
    ADD CONSTRAINT slack_installations_active_credential_valid CHECK (
        status <> 'ACTIVE' OR credential_secret_arn IS NOT NULL
    ),
    ADD CONSTRAINT slack_installations_status_revocation_consistent CHECK (
        (status = 'REVOKED' AND revoked_at IS NOT NULL)
        OR (status <> 'REVOKED' AND revoked_at IS NULL)
    ),
    ADD CONSTRAINT slack_installations_secret_arn_valid CHECK (
        credential_secret_arn IS NULL
        OR credential_secret_arn ~ '^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$'
    ),
    ADD CONSTRAINT slack_installations_expiry_valid CHECK (
        credential_expires_at IS NULL OR credential_expires_at >= installed_at
    ),
    ADD CONSTRAINT slack_installations_installer_subject_valid CHECK (
        installed_by_cognito_subject IS NULL
        OR char_length(installed_by_cognito_subject) BETWEEN 1 AND 128
    ),
    ADD CONSTRAINT slack_installations_error_code_valid CHECK (
        last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
    ),
    ADD CONSTRAINT slack_installations_version_valid CHECK (version >= 0);

ALTER TABLE reviewer_memberships
    ADD COLUMN slack_user_id TEXT,
    ADD CONSTRAINT reviewer_memberships_slack_user_id_valid CHECK (
        slack_user_id IS NULL OR slack_user_id ~ '^U[A-Z0-9]{1,63}$'
    );

CREATE UNIQUE INDEX reviewer_memberships_tenant_slack_user_unique
    ON reviewer_memberships (tenant_id, slack_user_id)
    WHERE slack_user_id IS NOT NULL;

CREATE TABLE slack_oauth_authorizations (
    id UUID PRIMARY KEY,
    state_sha256 CHAR(64) NOT NULL UNIQUE
        CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
    browser_binding_sha256 CHAR(64) NOT NULL
        CHECK (browser_binding_sha256 ~ '^[0-9a-f]{64}$'),
    cognito_subject TEXT NOT NULL
        CHECK (char_length(cognito_subject) BETWEEN 1 AND 128),
    redirect_uri TEXT NOT NULL
        CHECK (char_length(redirect_uri) BETWEEN 1 AND 2048),
    requested_scopes TEXT[] NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'CONSUMED', 'COMPLETED', 'FAILED')),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    failure_code TEXT,
    completed_installation_id TEXT,
    completion_kind TEXT CHECK (completion_kind IN ('CREATED', 'REINSTALLED')),
    CONSTRAINT slack_oauth_authorizations_installation_fk
        FOREIGN KEY (completed_installation_id)
        REFERENCES slack_installations(id) ON DELETE RESTRICT,
    CONSTRAINT slack_oauth_authorizations_time_order CHECK (
        expires_at > created_at
        AND expires_at <= created_at + INTERVAL '10 minutes'
        AND (consumed_at IS NULL OR consumed_at >= created_at)
        AND (completed_at IS NULL OR completed_at >= consumed_at)
        AND (failed_at IS NULL OR failed_at >= consumed_at)
    ),
    CONSTRAINT slack_oauth_authorizations_scopes_valid CHECK (
        cardinality(requested_scopes) = 6
        AND requested_scopes <@ ARRAY[
            'app_mentions:read',
            'channels:history',
            'channels:read',
            'chat:write',
            'commands',
            'users:read'
        ]::TEXT[]
        AND ARRAY[
            'app_mentions:read',
            'channels:history',
            'channels:read',
            'chat:write',
            'commands',
            'users:read'
        ]::TEXT[] <@ requested_scopes
    ),
    CONSTRAINT slack_oauth_authorizations_state_consistent CHECK (
        (
            status = 'PENDING'
            AND consumed_at IS NULL
            AND completed_at IS NULL
            AND failed_at IS NULL
            AND failure_code IS NULL
            AND completed_installation_id IS NULL
            AND completion_kind IS NULL
        )
        OR (
            status = 'CONSUMED'
            AND consumed_at IS NOT NULL
            AND completed_at IS NULL
            AND failed_at IS NULL
            AND failure_code IS NULL
            AND completed_installation_id IS NULL
            AND completion_kind IS NULL
        )
        OR (
            status = 'COMPLETED'
            AND consumed_at IS NOT NULL
            AND completed_at IS NOT NULL
            AND failed_at IS NULL
            AND failure_code IS NULL
            AND completed_installation_id IS NOT NULL
            AND completion_kind IS NOT NULL
        )
        OR (
            status = 'FAILED'
            AND consumed_at IS NOT NULL
            AND completed_at IS NULL
            AND failed_at IS NOT NULL
            AND failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
            AND completed_installation_id IS NULL
            AND completion_kind IS NULL
        )
    )
);

CREATE INDEX slack_oauth_authorizations_pending_expiry_idx
    ON slack_oauth_authorizations (expires_at, id)
    WHERE status = 'PENDING';

CREATE INDEX slack_oauth_authorizations_subject_created_idx
    ON slack_oauth_authorizations (cognito_subject, created_at DESC);
