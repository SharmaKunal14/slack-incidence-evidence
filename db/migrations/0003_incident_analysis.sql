-- Adds durable, versioned AI extraction runs and their evidence-linked output.
--
-- Production migrations are forward-only. A development-only rollback, before
-- any reviewer depends on generated records, is:
--   ALTER TABLE claims DROP COLUMN analysis_run_id;
--   ALTER TABLE timeline_events DROP COLUMN analysis_run_id;
--   DROP TABLE analysis_open_questions;
--   DROP TABLE timeline_event_evidence_links;
--   DROP TABLE incident_analysis_runs;
-- This rollback destroys generated analysis history and must not be used after
-- analysis results have entered review.

CREATE TABLE incident_analysis_runs (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    analysis_version INTEGER NOT NULL CHECK (analysis_version > 0),
    manifest_sha256 CHAR(64) NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    status TEXT NOT NULL CHECK (status IN (
        'RUNNING',
        'RETRY_WAIT',
        'COMPLETE',
        'FAILED'
    )),
    provider TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 64),
    model_name TEXT NOT NULL CHECK (char_length(model_name) BETWEEN 1 AND 200),
    prompt_version TEXT NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 64),
    schema_version TEXT NOT NULL CHECK (char_length(schema_version) BETWEEN 1 AND 64),
    client_request_id TEXT NOT NULL CHECK (char_length(client_request_id) BETWEEN 1 AND 128),
    provider_response_id TEXT,
    provider_model_name TEXT,
    input_artifact_count INTEGER NOT NULL CHECK (input_artifact_count > 0),
    input_characters INTEGER NOT NULL CHECK (input_characters > 0),
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
    available_at TIMESTAMPTZ NOT NULL,
    lease_token TEXT,
    lease_expires_at TIMESTAMPTZ,
    failure_code TEXT,
    timeline_event_count INTEGER NOT NULL DEFAULT 0 CHECK (timeline_event_count >= 0),
    claim_count INTEGER NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
    open_question_count INTEGER NOT NULL DEFAULT 0 CHECK (open_question_count >= 0),
    started_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    CONSTRAINT incident_analysis_runs_incident_fk
        FOREIGN KEY (tenant_id, incident_id)
        REFERENCES incidents(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT incident_analysis_runs_tenant_incident_id_unique
        UNIQUE (tenant_id, incident_id, id),
    CONSTRAINT incident_analysis_runs_version_unique
        UNIQUE (tenant_id, incident_id, analysis_version),
    CONSTRAINT incident_analysis_runs_client_request_unique
        UNIQUE (client_request_id),
    CONSTRAINT incident_analysis_runs_provider_response_valid CHECK (
        provider_response_id IS NULL
        OR char_length(provider_response_id) BETWEEN 1 AND 256
    ),
    CONSTRAINT incident_analysis_runs_provider_model_valid CHECK (
        provider_model_name IS NULL
        OR char_length(provider_model_name) BETWEEN 1 AND 200
    ),
    CONSTRAINT incident_analysis_runs_lease_valid CHECK (
        lease_token IS NULL OR char_length(lease_token) BETWEEN 1 AND 128
    ),
    CONSTRAINT incident_analysis_runs_failure_code_valid CHECK (
        failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,64}$'
    ),
    CONSTRAINT incident_analysis_runs_attempts_valid CHECK (
        attempt_count <= max_attempts
    ),
    CONSTRAINT incident_analysis_runs_usage_valid CHECK (
        (input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL)
        OR (
            input_tokens IS NOT NULL
            AND output_tokens IS NOT NULL
            AND total_tokens IS NOT NULL
            AND input_tokens >= 0
            AND output_tokens >= 0
            AND total_tokens = input_tokens + output_tokens
        )
    ),
    CONSTRAINT incident_analysis_runs_state_consistent CHECK (
        (
            status = 'RUNNING'
            AND lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND failure_code IS NULL
            AND provider_response_id IS NULL
            AND provider_model_name IS NULL
            AND input_tokens IS NULL
            AND timeline_event_count = 0
            AND claim_count = 0
            AND open_question_count = 0
            AND finished_at IS NULL
        )
        OR (
            status = 'RETRY_WAIT'
            AND lease_token IS NULL
            AND lease_expires_at IS NULL
            AND failure_code IS NOT NULL
            AND provider_response_id IS NULL
            AND provider_model_name IS NULL
            AND input_tokens IS NULL
            AND timeline_event_count = 0
            AND claim_count = 0
            AND open_question_count = 0
            AND finished_at IS NULL
        )
        OR (
            status = 'COMPLETE'
            AND lease_token IS NULL
            AND lease_expires_at IS NULL
            AND failure_code IS NULL
            AND provider_response_id IS NOT NULL
            AND provider_model_name IS NOT NULL
            AND input_tokens IS NOT NULL
            AND finished_at IS NOT NULL
        )
        OR (
            status = 'FAILED'
            AND lease_token IS NULL
            AND lease_expires_at IS NULL
            AND failure_code IS NOT NULL
            AND provider_response_id IS NULL
            AND provider_model_name IS NULL
            AND input_tokens IS NULL
            AND timeline_event_count = 0
            AND claim_count = 0
            AND open_question_count = 0
            AND finished_at IS NOT NULL
        )
    ),
    CONSTRAINT incident_analysis_runs_time_order CHECK (
        updated_at >= started_at
        AND (finished_at IS NULL OR finished_at >= started_at)
    )
);

CREATE INDEX incident_analysis_runs_status_available_idx
    ON incident_analysis_runs (status, available_at, updated_at);

ALTER TABLE timeline_events
    ADD COLUMN analysis_run_id TEXT;

ALTER TABLE timeline_events
    ADD CONSTRAINT timeline_events_analysis_run_fk
        FOREIGN KEY (tenant_id, incident_id, analysis_run_id)
        REFERENCES incident_analysis_runs(tenant_id, incident_id, id)
        ON DELETE CASCADE;

ALTER TABLE claims
    ADD COLUMN analysis_run_id TEXT;

ALTER TABLE claims
    ADD CONSTRAINT claims_analysis_run_fk
        FOREIGN KEY (tenant_id, incident_id, analysis_run_id)
        REFERENCES incident_analysis_runs(tenant_id, incident_id, id)
        ON DELETE CASCADE;

CREATE TABLE timeline_event_evidence_links (
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    timeline_event_id TEXT NOT NULL,
    source_artifact_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (
        tenant_id,
        incident_id,
        timeline_event_id,
        source_artifact_id
    ),
    CONSTRAINT timeline_event_evidence_links_event_fk
        FOREIGN KEY (tenant_id, incident_id, timeline_event_id)
        REFERENCES timeline_events(tenant_id, incident_id, id)
        ON DELETE CASCADE,
    CONSTRAINT timeline_event_evidence_links_source_fk
        FOREIGN KEY (tenant_id, incident_id, source_artifact_id)
        REFERENCES source_artifacts(tenant_id, incident_id, id)
        ON DELETE CASCADE
);

CREATE INDEX timeline_event_evidence_links_source_idx
    ON timeline_event_evidence_links (
        tenant_id,
        incident_id,
        source_artifact_id
    );

CREATE TABLE analysis_open_questions (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    analysis_run_id TEXT NOT NULL,
    question TEXT NOT NULL CHECK (char_length(btrim(question)) BETWEEN 1 AND 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT analysis_open_questions_run_fk
        FOREIGN KEY (tenant_id, incident_id, analysis_run_id)
        REFERENCES incident_analysis_runs(tenant_id, incident_id, id)
        ON DELETE CASCADE,
    CONSTRAINT analysis_open_questions_tenant_incident_id_unique
        UNIQUE (tenant_id, incident_id, id)
);

CREATE INDEX analysis_open_questions_run_idx
    ON analysis_open_questions (tenant_id, incident_id, analysis_run_id);
