-- Durable, tenant-scoped source planning, collection checkpoints, and coverage.
-- This project uses forward-only production migrations. A development-only
-- rollback may drop these four tables and the three incident columns below
-- before scoped incidents exist; doing so afterwards destroys audit history.

ALTER TABLE incidents
    ADD COLUMN reviewer_user_id TEXT;

ALTER TABLE incidents
    ADD COLUMN evidence_retention_days INTEGER;

ALTER TABLE incidents
    ADD CONSTRAINT incidents_reviewer_user_id_valid CHECK (
        reviewer_user_id IS NULL OR reviewer_user_id ~ '^U[A-Z0-9]{1,63}$'
    );

ALTER TABLE incidents
    ADD CONSTRAINT incidents_evidence_retention_days_valid CHECK (
        evidence_retention_days IS NULL
        OR evidence_retention_days BETWEEN 1 AND 365
    );

CREATE TABLE incident_sources (
    id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('SLACK', 'GITHUB')),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('SLACK_CHANNEL', 'SLACK_THREAD', 'GITHUB_REPOSITORY')),
    source_role TEXT NOT NULL CHECK (source_role IN ('PRIMARY', 'ADDITIONAL', 'ANCHOR')),
    provider_source_id TEXT NOT NULL CHECK (char_length(provider_source_id) BETWEEN 1 AND 256),
    idempotency_identity TEXT NOT NULL CHECK (char_length(idempotency_identity) BETWEEN 1 AND 512),
    display_name TEXT CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
    requested_start_at TIMESTAMPTZ NOT NULL,
    requested_end_at TIMESTAMPTZ NOT NULL,
    anchor_thread_timestamps TEXT[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN (
        'PLANNED', 'COLLECTING', 'COMPLETE', 'PARTIAL',
        'INACCESSIBLE', 'REVOKED', 'FAILED', 'EXCLUDED'
    )),
    reviewer_excluded_at TIMESTAMPTZ,
    reviewer_excluded_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    PRIMARY KEY (tenant_id, incident_id, id),
    CONSTRAINT incident_sources_incident_fk
        FOREIGN KEY (tenant_id, incident_id)
        REFERENCES incidents(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT incident_sources_identity_unique
        UNIQUE (tenant_id, incident_id, idempotency_identity),
    CONSTRAINT incident_sources_window_valid CHECK (requested_end_at > requested_start_at),
    CONSTRAINT incident_sources_window_bounded CHECK (
        requested_end_at - requested_start_at <= INTERVAL '7 days'
    ),
    CONSTRAINT incident_sources_slack_channel_valid CHECK (
        provider <> 'SLACK' OR provider_source_id ~ '^C[A-Z0-9]{1,63}$'
    ),
    CONSTRAINT incident_sources_anchor_timestamps_valid CHECK (
        cardinality(anchor_thread_timestamps) <= 5
        AND (
            cardinality(anchor_thread_timestamps) = 0
            OR array_to_string(anchor_thread_timestamps, ',')
                ~ '^[0-9]{1,20}\.[0-9]{1,20}(,[0-9]{1,20}\.[0-9]{1,20}){0,4}$'
        )
    ),
    CONSTRAINT incident_sources_exclusion_consistent CHECK (
        (status = 'EXCLUDED' AND reviewer_excluded_at IS NOT NULL AND reviewer_excluded_by IS NOT NULL)
        OR (status <> 'EXCLUDED' AND reviewer_excluded_at IS NULL AND reviewer_excluded_by IS NULL)
    ),
    CONSTRAINT incident_sources_updated_after_creation CHECK (updated_at >= created_at)
);

CREATE INDEX incident_sources_incident_status_idx
    ON incident_sources (tenant_id, incident_id, status, id);

CREATE TABLE source_collection_runs (
    id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    run_version INTEGER NOT NULL DEFAULT 1 CHECK (run_version > 0),
    idempotency_identity TEXT NOT NULL CHECK (char_length(idempotency_identity) BETWEEN 1 AND 512),
    status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN (
        'PLANNED', 'COLLECTING', 'COMPLETE', 'PARTIAL',
        'INACCESSIBLE', 'REVOKED', 'FAILED', 'EXCLUDED'
    )),
    requested_start_at TIMESTAMPTZ NOT NULL,
    requested_end_at TIMESTAMPTZ NOT NULL,
    collected_message_count INTEGER NOT NULL DEFAULT 0 CHECK (collected_message_count >= 0),
    permission_outcome TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (
        permission_outcome IN ('UNKNOWN', 'ALLOWED', 'DENIED', 'REVOKED')
    ),
    provider_rate_limit_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    missing_or_excluded_periods JSONB NOT NULL DEFAULT '[]'::jsonb,
    completion_reason TEXT,
    failure_reason TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    PRIMARY KEY (tenant_id, incident_id, id),
    CONSTRAINT source_collection_runs_source_fk
        FOREIGN KEY (tenant_id, incident_id, source_id)
        REFERENCES incident_sources(tenant_id, incident_id, id) ON DELETE CASCADE,
    CONSTRAINT source_collection_runs_source_version_unique
        UNIQUE (tenant_id, incident_id, source_id, run_version),
    CONSTRAINT source_collection_runs_source_id_unique
        UNIQUE (tenant_id, incident_id, source_id, id),
    CONSTRAINT source_collection_runs_identity_unique
        UNIQUE (tenant_id, incident_id, idempotency_identity),
    CONSTRAINT source_collection_runs_window_valid CHECK (requested_end_at > requested_start_at),
    CONSTRAINT source_collection_runs_rate_state_object CHECK (jsonb_typeof(provider_rate_limit_state) = 'object'),
    CONSTRAINT source_collection_runs_missing_periods_array CHECK (jsonb_typeof(missing_or_excluded_periods) = 'array'),
    CONSTRAINT source_collection_runs_reason_valid CHECK (
        (completion_reason IS NULL OR completion_reason ~ '^[A-Z0-9_]{1,64}$')
        AND (failure_reason IS NULL OR failure_reason ~ '^[A-Z0-9_]{1,64}$')
    ),
    CONSTRAINT source_collection_runs_terminal_consistent CHECK (
        (status IN ('PLANNED', 'COLLECTING') AND finished_at IS NULL)
        OR (status NOT IN ('PLANNED', 'COLLECTING') AND finished_at IS NOT NULL)
    ),
    CONSTRAINT source_collection_runs_updated_after_creation CHECK (updated_at >= created_at)
);

CREATE INDEX source_collection_runs_status_updated_idx
    ON source_collection_runs (status, updated_at);

CREATE TABLE source_collection_checkpoints (
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'CHANNEL' CHECK (phase IN ('CHANNEL', 'ANCHOR_THREAD', 'COMPLETE')),
    anchor_index INTEGER NOT NULL DEFAULT 0 CHECK (anchor_index >= 0 AND anchor_index <= 5),
    collection_cursor TEXT,
    pages_collected INTEGER NOT NULL DEFAULT 0 CHECK (pages_collected >= 0),
    collected_message_count INTEGER NOT NULL DEFAULT 0 CHECK (collected_message_count >= 0),
    last_collected_at TIMESTAMPTZ,
    rate_limit_count INTEGER NOT NULL DEFAULT 0 CHECK (rate_limit_count >= 0),
    transient_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (transient_failure_count >= 0),
    rate_limited_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    PRIMARY KEY (tenant_id, incident_id, source_id, run_id),
    CONSTRAINT source_collection_checkpoints_run_fk
        FOREIGN KEY (tenant_id, incident_id, source_id, run_id)
        REFERENCES source_collection_runs(tenant_id, incident_id, source_id, id) ON DELETE CASCADE,
    CONSTRAINT source_collection_checkpoints_cursor_valid CHECK (
        collection_cursor IS NULL OR char_length(collection_cursor) BETWEEN 1 AND 2048
    ),
    CONSTRAINT source_collection_checkpoints_updated_after_creation CHECK (updated_at >= created_at)
);

CREATE TABLE source_coverage_manifests (
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    manifest_version INTEGER NOT NULL DEFAULT 1 CHECK (manifest_version > 0),
    source_state TEXT NOT NULL CHECK (source_state IN (
        'PLANNED', 'COLLECTING', 'COMPLETE', 'PARTIAL',
        'INACCESSIBLE', 'REVOKED', 'FAILED', 'EXCLUDED'
    )),
    collected_message_count INTEGER NOT NULL DEFAULT 0 CHECK (collected_message_count >= 0),
    requested_start_at TIMESTAMPTZ NOT NULL,
    requested_end_at TIMESTAMPTZ NOT NULL,
    missing_or_excluded_periods JSONB NOT NULL DEFAULT '[]'::jsonb,
    permission_outcome TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (
        permission_outcome IN ('UNKNOWN', 'ALLOWED', 'DENIED', 'REVOKED')
    ),
    provider_rate_limit_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    completion_or_failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (tenant_id, incident_id, source_id, manifest_version),
    CONSTRAINT source_coverage_manifests_source_fk
        FOREIGN KEY (tenant_id, incident_id, source_id)
        REFERENCES incident_sources(tenant_id, incident_id, id) ON DELETE CASCADE,
    CONSTRAINT source_coverage_manifests_missing_periods_array CHECK (jsonb_typeof(missing_or_excluded_periods) = 'array'),
    CONSTRAINT source_coverage_manifests_rate_state_object CHECK (jsonb_typeof(provider_rate_limit_state) = 'object'),
    CONSTRAINT source_coverage_manifests_reason_valid CHECK (
        completion_or_failure_reason IS NULL
        OR completion_or_failure_reason ~ '^[A-Z0-9_]{1,64}$'
    ),
    CONSTRAINT source_coverage_manifests_updated_after_creation CHECK (updated_at >= created_at)
);

CREATE INDEX source_coverage_manifests_incident_idx
    ON source_coverage_manifests (tenant_id, incident_id, source_state, source_id);
