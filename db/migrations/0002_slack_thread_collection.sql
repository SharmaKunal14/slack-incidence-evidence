-- Adds the durable checkpoint for the first evidence-collection source.
--
-- This project uses forward-only production migrations. Before deploying code
-- that writes these fields, a development-only rollback is:
--   DROP TABLE slack_thread_collections;
--   ALTER TABLE incidents DROP COLUMN source_message_ts;
-- Do not run that rollback after evidence collection has started; it destroys
-- collection progress and makes existing incidents impossible to recollect.

ALTER TABLE incidents
    ADD COLUMN source_message_ts TEXT;

ALTER TABLE incidents
    ADD CONSTRAINT incidents_message_ts_valid CHECK (
        source_message_ts IS NULL
        OR source_message_ts ~ '^[0-9]{1,20}\.[0-9]{1,20}$'
    );

CREATE TABLE slack_thread_collections (
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL CHECK (workspace_id ~ '^T[A-Z0-9]{1,63}$'),
    channel_id TEXT NOT NULL CHECK (channel_id ~ '^C[A-Z0-9]{1,63}$'),
    thread_ts TEXT NOT NULL CHECK (thread_ts ~ '^[0-9]{1,20}\.[0-9]{1,20}$'),
    status TEXT NOT NULL DEFAULT 'RUNNING'
        CHECK (status IN ('RUNNING', 'COMPLETE', 'FAILED')),
    next_cursor TEXT,
    messages_collected INTEGER NOT NULL DEFAULT 0 CHECK (messages_collected >= 0),
    pages_collected INTEGER NOT NULL DEFAULT 0 CHECK (pages_collected >= 0),
    failure_code TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    finished_at TIMESTAMPTZ,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    PRIMARY KEY (tenant_id, incident_id),
    CONSTRAINT slack_thread_collections_incident_fk
        FOREIGN KEY (tenant_id, incident_id)
        REFERENCES incidents(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT slack_thread_collections_cursor_valid CHECK (
        next_cursor IS NULL OR char_length(next_cursor) BETWEEN 1 AND 2048
    ),
    CONSTRAINT slack_thread_collections_failure_code_valid CHECK (
        failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,64}$'
    ),
    CONSTRAINT slack_thread_collections_state_consistent CHECK (
        (status = 'RUNNING' AND finished_at IS NULL AND failure_code IS NULL)
        OR (
            status = 'COMPLETE'
            AND finished_at IS NOT NULL
            AND next_cursor IS NULL
            AND failure_code IS NULL
        )
        OR (
            status = 'FAILED'
            AND finished_at IS NOT NULL
            AND failure_code IS NOT NULL
        )
    ),
    CONSTRAINT slack_thread_collections_updated_after_start CHECK (
        updated_at >= started_at
    )
);

CREATE INDEX slack_thread_collections_status_updated_idx
    ON slack_thread_collections (status, updated_at);
