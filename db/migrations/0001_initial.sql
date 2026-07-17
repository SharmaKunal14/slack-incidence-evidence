-- The schema is deliberately tenant-keyed throughout. Composite foreign keys
-- prevent a programming error from associating evidence from one tenant with an
-- incident owned by another tenant.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version BIGINT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum CHAR(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    execution_time_ms INTEGER NOT NULL CHECK (execution_time_ms >= 0),
    applied_by TEXT NOT NULL
);

CREATE TABLE tenants (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    display_name TEXT NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200),
    status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT tenants_updated_after_creation CHECK (updated_at >= created_at),
    CONSTRAINT tenants_deletion_state_consistent CHECK (
        (status = 'DELETED' AND deleted_at IS NOT NULL)
        OR (status <> 'DELETED' AND deleted_at IS NULL)
    )
);

CREATE TABLE slack_installations (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    team_id TEXT NOT NULL CHECK (char_length(team_id) BETWEEN 1 AND 64),
    enterprise_id TEXT,
    app_id TEXT NOT NULL CHECK (char_length(app_id) BETWEEN 1 AND 64),
    bot_user_id TEXT NOT NULL CHECK (char_length(bot_user_id) BETWEEN 1 AND 64),
    installed_by_user_id TEXT NOT NULL CHECK (char_length(installed_by_user_id) BETWEEN 1 AND 64),
    bot_token_ciphertext BYTEA NOT NULL,
    encryption_key_id TEXT NOT NULL CHECK (char_length(encryption_key_id) BETWEEN 1 AND 256),
    granted_scopes TEXT[] NOT NULL DEFAULT '{}',
    installed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    revoked_at TIMESTAMPTZ,
    CONSTRAINT slack_installations_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    CONSTRAINT slack_installations_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT slack_installations_workspace_unique UNIQUE (team_id),
    CONSTRAINT slack_installations_tenant_workspace_unique UNIQUE (tenant_id, team_id),
    CONSTRAINT slack_installations_updated_after_install CHECK (updated_at >= installed_at),
    CONSTRAINT slack_installations_revoked_after_install CHECK (
        revoked_at IS NULL OR revoked_at >= installed_at
    ),
    CONSTRAINT slack_installations_enterprise_id_valid CHECK (
        enterprise_id IS NULL OR char_length(enterprise_id) BETWEEN 1 AND 64
    ),
    CONSTRAINT slack_installations_nonempty_token CHECK (octet_length(bot_token_ciphertext) > 0)
);

CREATE INDEX slack_installations_tenant_idx
    ON slack_installations (tenant_id);

CREATE TABLE incidents (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL CHECK (char_length(source_event_id) BETWEEN 1 AND 128),
    source_workspace_id TEXT NOT NULL CHECK (char_length(source_workspace_id) BETWEEN 1 AND 64),
    source_channel_id TEXT NOT NULL CHECK (char_length(source_channel_id) BETWEEN 1 AND 64),
    source_thread_ts TEXT,
    requested_by_user_id TEXT NOT NULL CHECK (char_length(requested_by_user_id) BETWEEN 1 AND 64),
    title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 500),
    status TEXT NOT NULL CHECK (status IN (
        'DISCOVERED',
        'COLLECTING',
        'NORMALIZING',
        'EXTRACTING',
        'GENERATING',
        'VERIFYING',
        'NEEDS_REVIEW',
        'APPROVED',
        'PUBLISHED',
        'CLOSED',
        'FAILED'
    )),
    severity TEXT NOT NULL DEFAULT 'UNCLASSIFIED'
        CHECK (severity IN ('UNCLASSIFIED', 'SEV0', 'SEV1', 'SEV2', 'SEV3', 'SEV4')),
    started_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    CONSTRAINT incidents_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    CONSTRAINT incidents_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT incidents_source_event_unique UNIQUE (tenant_id, source_event_id),
    CONSTRAINT incidents_thread_ts_valid CHECK (
        source_thread_ts IS NULL OR char_length(source_thread_ts) BETWEEN 1 AND 64
    ),
    CONSTRAINT incidents_updated_after_creation CHECK (updated_at >= created_at),
    CONSTRAINT incidents_resolved_after_start CHECK (
        resolved_at IS NULL OR started_at IS NULL OR resolved_at >= started_at
    )
);

CREATE INDEX incidents_tenant_status_updated_idx
    ON incidents (tenant_id, status, updated_at DESC);

CREATE INDEX incidents_tenant_created_idx
    ON incidents (tenant_id, created_at DESC);

CREATE TABLE source_artifacts (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN (
        'SLACK_MESSAGE',
        'SLACK_FILE',
        'GITHUB_COMMIT',
        'GITHUB_PULL_REQUEST',
        'GITHUB_DEPLOYMENT',
        'GITHUB_WORKFLOW_RUN',
        'GITHUB_ISSUE',
        'MANUAL'
    )),
    external_id TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 512),
    source_uri TEXT,
    author_external_id TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    content TEXT,
    content_sha256 CHAR(64),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    retention_expires_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT source_artifacts_incident_fk
        FOREIGN KEY (tenant_id, incident_id)
        REFERENCES incidents(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT source_artifacts_tenant_incident_id_unique
        UNIQUE (tenant_id, incident_id, id),
    CONSTRAINT source_artifacts_external_unique
        UNIQUE (tenant_id, incident_id, source_type, external_id),
    CONSTRAINT source_artifacts_uri_valid CHECK (
        source_uri IS NULL OR char_length(source_uri) BETWEEN 1 AND 4096
    ),
    CONSTRAINT source_artifacts_author_valid CHECK (
        author_external_id IS NULL OR char_length(author_external_id) BETWEEN 1 AND 256
    ),
    CONSTRAINT source_artifacts_sha256_valid CHECK (
        content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT source_artifacts_content_integrity CHECK (
        content IS NOT NULL OR content_sha256 IS NULL
    ),
    CONSTRAINT source_artifacts_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
    CONSTRAINT source_artifacts_retention_after_creation CHECK (
        retention_expires_at IS NULL OR retention_expires_at >= created_at
    )
);

CREATE INDEX source_artifacts_incident_time_idx
    ON source_artifacts (tenant_id, incident_id, occurred_at, id)
    WHERE deleted_at IS NULL;

CREATE INDEX source_artifacts_retention_idx
    ON source_artifacts (retention_expires_at)
    WHERE retention_expires_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE timeline_events (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (char_length(btrim(event_type)) BETWEEN 1 AND 100),
    classification TEXT NOT NULL CHECK (classification IN (
        'DIRECTLY_OBSERVED',
        'CORROBORATED',
        'PARTICIPANT_ASSERTION',
        'HYPOTHESIS',
        'CORRELATED_INFERENCE',
        'DISPUTED',
        'UNKNOWN',
        'HUMAN_CONFIRMED'
    )),
    event_time TIMESTAMPTZ NOT NULL,
    reported_at TIMESTAMPTZ,
    summary TEXT NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 1 AND 4000),
    actor_external_id TEXT,
    source_artifact_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT timeline_events_incident_fk
        FOREIGN KEY (tenant_id, incident_id)
        REFERENCES incidents(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT timeline_events_source_artifact_fk
        FOREIGN KEY (tenant_id, incident_id, source_artifact_id)
        REFERENCES source_artifacts(tenant_id, incident_id, id) ON DELETE RESTRICT,
    CONSTRAINT timeline_events_tenant_incident_id_unique
        UNIQUE (tenant_id, incident_id, id),
    CONSTRAINT timeline_events_actor_valid CHECK (
        actor_external_id IS NULL OR char_length(actor_external_id) BETWEEN 1 AND 256
    ),
    CONSTRAINT timeline_events_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
    CONSTRAINT timeline_events_updated_after_creation CHECK (updated_at >= created_at)
);

CREATE INDEX timeline_events_incident_time_idx
    ON timeline_events (tenant_id, incident_id, event_time, id);

CREATE TABLE claims (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    statement TEXT NOT NULL CHECK (char_length(btrim(statement)) BETWEEN 1 AND 8000),
    classification TEXT NOT NULL CHECK (classification IN (
        'DIRECTLY_OBSERVED',
        'CORROBORATED',
        'PARTICIPANT_ASSERTION',
        'HYPOTHESIS',
        'CORRELATED_INFERENCE',
        'DISPUTED',
        'UNKNOWN',
        'HUMAN_CONFIRMED'
    )),
    review_status TEXT NOT NULL DEFAULT 'UNREVIEWED'
        CHECK (review_status IN ('UNREVIEWED', 'ACCEPTED', 'REJECTED', 'NEEDS_CLARIFICATION')),
    reviewed_by_user_id TEXT,
    reviewed_at TIMESTAMPTZ,
    model_provider TEXT,
    model_name TEXT,
    prompt_version TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    CONSTRAINT claims_incident_fk
        FOREIGN KEY (tenant_id, incident_id)
        REFERENCES incidents(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT claims_tenant_incident_id_unique
        UNIQUE (tenant_id, incident_id, id),
    CONSTRAINT claims_review_consistent CHECK (
        (review_status = 'UNREVIEWED' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
        OR (review_status <> 'UNREVIEWED' AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
    ),
    CONSTRAINT claims_model_metadata_consistent CHECK (
        (model_provider IS NULL AND model_name IS NULL AND prompt_version IS NULL)
        OR (model_provider IS NOT NULL AND model_name IS NOT NULL AND prompt_version IS NOT NULL)
    ),
    CONSTRAINT claims_updated_after_creation CHECK (updated_at >= created_at)
);

CREATE INDEX claims_incident_review_idx
    ON claims (tenant_id, incident_id, review_status, created_at);

CREATE TABLE claim_evidence_links (
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    source_artifact_id TEXT NOT NULL,
    relationship TEXT NOT NULL CHECK (relationship IN ('SUPPORTS', 'CONTRADICTS', 'CONTEXT')),
    rationale TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (tenant_id, incident_id, claim_id, source_artifact_id, relationship),
    CONSTRAINT claim_evidence_links_claim_fk
        FOREIGN KEY (tenant_id, incident_id, claim_id)
        REFERENCES claims(tenant_id, incident_id, id) ON DELETE CASCADE,
    CONSTRAINT claim_evidence_links_source_fk
        FOREIGN KEY (tenant_id, incident_id, source_artifact_id)
        REFERENCES source_artifacts(tenant_id, incident_id, id) ON DELETE CASCADE,
    CONSTRAINT claim_evidence_links_rationale_valid CHECK (
        rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 4000
    )
);

CREATE INDEX claim_evidence_links_source_idx
    ON claim_evidence_links (tenant_id, incident_id, source_artifact_id);

CREATE TABLE workflow_jobs (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT,
    job_type TEXT NOT NULL CHECK (char_length(btrim(job_type)) BETWEEN 1 AND 100),
    idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
    status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'RUNNING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    locked_at TIMESTAMPTZ,
    locked_by TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB,
    last_error JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    finished_at TIMESTAMPTZ,
    CONSTRAINT workflow_jobs_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    CONSTRAINT workflow_jobs_incident_fk
        FOREIGN KEY (tenant_id, incident_id)
        REFERENCES incidents(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT workflow_jobs_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT workflow_jobs_idempotency_unique UNIQUE (tenant_id, idempotency_key),
    CONSTRAINT workflow_jobs_attempts_valid CHECK (attempt_count <= max_attempts),
    CONSTRAINT workflow_jobs_lock_consistent CHECK (
        (status = 'RUNNING' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
        OR (status <> 'RUNNING' AND locked_at IS NULL AND locked_by IS NULL)
    ),
    CONSTRAINT workflow_jobs_result_object CHECK (
        result IS NULL OR jsonb_typeof(result) = 'object'
    ),
    CONSTRAINT workflow_jobs_error_object CHECK (
        last_error IS NULL OR jsonb_typeof(last_error) = 'object'
    ),
    CONSTRAINT workflow_jobs_payload_object CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT workflow_jobs_completion_consistent CHECK (
        (status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND finished_at IS NOT NULL)
        OR (status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND finished_at IS NULL)
    ),
    CONSTRAINT workflow_jobs_updated_after_creation CHECK (updated_at >= created_at)
);

CREATE INDEX workflow_jobs_ready_idx
    ON workflow_jobs (available_at, created_at)
    WHERE status IN ('QUEUED', 'RETRY_SCHEDULED');

CREATE INDEX workflow_jobs_incident_idx
    ON workflow_jobs (tenant_id, incident_id, created_at DESC)
    WHERE incident_id IS NOT NULL;

CREATE TABLE audit_events (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'SLACK', 'GITHUB', 'MODEL')),
    actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 256),
    action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 200),
    target_type TEXT NOT NULL CHECK (char_length(target_type) BETWEEN 1 AND 100),
    target_id TEXT NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 256),
    request_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT audit_events_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    CONSTRAINT audit_events_incident_fk
        FOREIGN KEY (tenant_id, incident_id)
        REFERENCES incidents(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT audit_events_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT audit_events_request_id_valid CHECK (
        request_id IS NULL OR char_length(request_id) BETWEEN 1 AND 256
    ),
    CONSTRAINT audit_events_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX audit_events_tenant_time_idx
    ON audit_events (tenant_id, occurred_at DESC, id);

CREATE INDEX audit_events_incident_time_idx
    ON audit_events (tenant_id, incident_id, occurred_at DESC, id)
    WHERE incident_id IS NOT NULL;
