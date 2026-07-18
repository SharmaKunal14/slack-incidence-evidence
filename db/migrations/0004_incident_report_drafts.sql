-- Adds durable, versioned, evidence-linked postmortem drafts.
--
-- Production migrations are forward-only. A development-only rollback, before
-- any review decision depends on a generated draft, is:
--   DROP TABLE report_statement_timeline_event_links;
--   DROP TABLE report_statement_claim_links;
--   DROP TABLE incident_report_statements;
--   DROP TABLE incident_report_sections;
--   DROP TABLE incident_report_drafts;
-- This rollback destroys generated draft history and must not be used after a
-- reviewer has consumed or approved a draft.

CREATE TABLE incident_report_drafts (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    analysis_run_id TEXT NOT NULL,
    draft_version INTEGER NOT NULL CHECK (draft_version > 0),
    input_manifest_sha256 CHAR(64) NOT NULL
        CHECK (input_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    status TEXT NOT NULL CHECK (status IN (
        'RUNNING',
        'RETRY_WAIT',
        'NEEDS_REVIEW',
        'FAILED'
    )),
    provider TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 64),
    model_name TEXT NOT NULL CHECK (char_length(model_name) BETWEEN 1 AND 200),
    prompt_version TEXT NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 64),
    schema_version TEXT NOT NULL CHECK (char_length(schema_version) BETWEEN 1 AND 64),
    client_request_id TEXT NOT NULL CHECK (char_length(client_request_id) BETWEEN 1 AND 128),
    provider_response_id TEXT,
    provider_model_name TEXT,
    input_claim_count INTEGER NOT NULL CHECK (input_claim_count >= 0),
    input_timeline_event_count INTEGER NOT NULL CHECK (input_timeline_event_count >= 0),
    input_open_question_count INTEGER NOT NULL CHECK (input_open_question_count >= 0),
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
    section_count INTEGER NOT NULL DEFAULT 0 CHECK (section_count >= 0),
    statement_count INTEGER NOT NULL DEFAULT 0 CHECK (statement_count >= 0),
    rendered_markdown TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    CONSTRAINT incident_report_drafts_analysis_fk
        FOREIGN KEY (tenant_id, incident_id, analysis_run_id)
        REFERENCES incident_analysis_runs(tenant_id, incident_id, id)
        ON DELETE CASCADE,
    CONSTRAINT incident_report_drafts_tenant_incident_id_unique
        UNIQUE (tenant_id, incident_id, id),
    CONSTRAINT incident_report_drafts_version_unique
        UNIQUE (tenant_id, incident_id, analysis_run_id, draft_version),
    CONSTRAINT incident_report_drafts_client_request_unique
        UNIQUE (client_request_id),
    CONSTRAINT incident_report_drafts_provider_response_valid CHECK (
        provider_response_id IS NULL
        OR char_length(provider_response_id) BETWEEN 1 AND 256
    ),
    CONSTRAINT incident_report_drafts_provider_model_valid CHECK (
        provider_model_name IS NULL
        OR char_length(provider_model_name) BETWEEN 1 AND 200
    ),
    CONSTRAINT incident_report_drafts_lease_valid CHECK (
        lease_token IS NULL OR char_length(lease_token) BETWEEN 1 AND 128
    ),
    CONSTRAINT incident_report_drafts_failure_code_valid CHECK (
        failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,64}$'
    ),
    CONSTRAINT incident_report_drafts_attempts_valid CHECK (
        attempt_count <= max_attempts
    ),
    CONSTRAINT incident_report_drafts_usage_valid CHECK (
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
    CONSTRAINT incident_report_drafts_state_consistent CHECK (
        (
            status = 'RUNNING'
            AND lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND failure_code IS NULL
            AND provider_response_id IS NULL
            AND provider_model_name IS NULL
            AND input_tokens IS NULL
            AND rendered_markdown IS NULL
            AND section_count = 0
            AND statement_count = 0
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
            AND rendered_markdown IS NULL
            AND section_count = 0
            AND statement_count = 0
            AND finished_at IS NULL
        )
        OR (
            status = 'NEEDS_REVIEW'
            AND lease_token IS NULL
            AND lease_expires_at IS NULL
            AND failure_code IS NULL
            AND provider_response_id IS NOT NULL
            AND provider_model_name IS NOT NULL
            AND input_tokens IS NOT NULL
            AND rendered_markdown IS NOT NULL
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
            AND rendered_markdown IS NULL
            AND section_count = 0
            AND statement_count = 0
            AND finished_at IS NOT NULL
        )
    ),
    CONSTRAINT incident_report_drafts_time_order CHECK (
        updated_at >= started_at
        AND (finished_at IS NULL OR finished_at >= started_at)
    )
);

CREATE INDEX incident_report_drafts_status_available_idx
    ON incident_report_drafts (status, available_at, updated_at);

CREATE TABLE incident_report_sections (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    report_draft_id TEXT NOT NULL,
    section_type TEXT NOT NULL CHECK (section_type IN (
        'EXECUTIVE_SUMMARY',
        'IMPACT',
        'DETECTION',
        'TIMELINE',
        'ROOT_CAUSE',
        'CONTRIBUTING_FACTORS',
        'MITIGATION_AND_RECOVERY',
        'WHAT_WENT_WELL',
        'WHAT_DID_NOT_GO_WELL',
        'FOLLOW_UP_RECOMMENDATIONS'
    )),
    position INTEGER NOT NULL CHECK (position >= 0 AND position < 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT incident_report_sections_draft_fk
        FOREIGN KEY (tenant_id, incident_id, report_draft_id)
        REFERENCES incident_report_drafts(tenant_id, incident_id, id)
        ON DELETE CASCADE,
    CONSTRAINT incident_report_sections_tenant_incident_id_unique
        UNIQUE (tenant_id, incident_id, id),
    CONSTRAINT incident_report_sections_draft_type_unique
        UNIQUE (tenant_id, incident_id, report_draft_id, section_type),
    CONSTRAINT incident_report_sections_draft_position_unique
        UNIQUE (tenant_id, incident_id, report_draft_id, position),
    CONSTRAINT incident_report_sections_draft_id_unique
        UNIQUE (tenant_id, incident_id, report_draft_id, id)
);

CREATE TABLE incident_report_statements (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    report_draft_id TEXT NOT NULL,
    report_section_id TEXT NOT NULL,
    model_key TEXT NOT NULL CHECK (model_key ~ '^[a-z][a-z0-9_]{0,63}$'),
    statement_type TEXT NOT NULL CHECK (statement_type IN ('CLAIM', 'TIMELINE')),
    statement TEXT NOT NULL CHECK (char_length(btrim(statement)) BETWEEN 1 AND 4000),
    classification TEXT NOT NULL CHECK (classification IN (
        'DIRECTLY_OBSERVED',
        'CORROBORATED',
        'PARTICIPANT_ASSERTION',
        'HYPOTHESIS',
        'CORRELATED_INFERENCE',
        'DISPUTED',
        'UNKNOWN'
    )),
    position INTEGER NOT NULL CHECK (position >= 0 AND position < 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT incident_report_statements_section_fk
        FOREIGN KEY (
            tenant_id,
            incident_id,
            report_draft_id,
            report_section_id
        )
        REFERENCES incident_report_sections(
            tenant_id,
            incident_id,
            report_draft_id,
            id
        ) ON DELETE CASCADE,
    CONSTRAINT incident_report_statements_tenant_incident_id_unique
        UNIQUE (tenant_id, incident_id, id),
    CONSTRAINT incident_report_statements_draft_key_unique
        UNIQUE (tenant_id, incident_id, report_draft_id, model_key),
    CONSTRAINT incident_report_statements_section_position_unique
        UNIQUE (tenant_id, incident_id, report_section_id, position)
);

CREATE TABLE report_statement_claim_links (
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    report_statement_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (tenant_id, incident_id, report_statement_id, claim_id),
    CONSTRAINT report_statement_claim_links_statement_fk
        FOREIGN KEY (tenant_id, incident_id, report_statement_id)
        REFERENCES incident_report_statements(tenant_id, incident_id, id)
        ON DELETE CASCADE,
    CONSTRAINT report_statement_claim_links_claim_fk
        FOREIGN KEY (tenant_id, incident_id, claim_id)
        REFERENCES claims(tenant_id, incident_id, id)
        ON DELETE RESTRICT
);

CREATE INDEX report_statement_claim_links_claim_idx
    ON report_statement_claim_links (tenant_id, incident_id, claim_id);

CREATE TABLE report_statement_timeline_event_links (
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    report_statement_id TEXT NOT NULL,
    timeline_event_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (
        tenant_id,
        incident_id,
        report_statement_id,
        timeline_event_id
    ),
    CONSTRAINT report_statement_timeline_links_statement_fk
        FOREIGN KEY (tenant_id, incident_id, report_statement_id)
        REFERENCES incident_report_statements(tenant_id, incident_id, id)
        ON DELETE CASCADE,
    CONSTRAINT report_statement_timeline_links_event_fk
        FOREIGN KEY (tenant_id, incident_id, timeline_event_id)
        REFERENCES timeline_events(tenant_id, incident_id, id)
        ON DELETE RESTRICT
);

CREATE INDEX report_statement_timeline_links_event_idx
    ON report_statement_timeline_event_links (
        tenant_id,
        incident_id,
        timeline_event_id
    );
