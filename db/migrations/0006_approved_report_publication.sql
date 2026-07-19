-- Adds a transactional publication outbox for approved report revisions.
-- Approval and publication scheduling commit together; a scheduled worker owns
-- the two non-transactional external effects and checkpoints Notion before
-- Slack. This migration also queues previously approved revisions.
--
-- Production migrations are forward-only. A development-only rollback is:
--   DROP TABLE report_publications;
-- Do not roll back after an external page has been published because deleting
-- this table removes the durable record used to suppress duplicate publishing.

CREATE TABLE report_publications (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    report_revision_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'NOTION_PUBLISHED', 'COMPLETE', 'FAILED')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL,
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    notion_page_id TEXT CHECK (
        notion_page_id IS NULL OR char_length(notion_page_id) BETWEEN 1 AND 128
    ),
    notion_page_url TEXT CHECK (
        notion_page_url IS NULL OR char_length(notion_page_url) BETWEEN 1 AND 2000
    ),
    slack_message_ts TEXT CHECK (
        slack_message_ts IS NULL OR slack_message_ts ~ '^[0-9]{1,20}\.[0-9]{1,20}$'
    ),
    last_error_code TEXT CHECK (
        last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 128
    ),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    CONSTRAINT report_publications_revision_fk
        FOREIGN KEY (tenant_id, incident_id, report_revision_id)
        REFERENCES report_revisions(tenant_id, incident_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT report_publications_revision_unique
        UNIQUE (tenant_id, incident_id, report_revision_id),
    CONSTRAINT report_publications_lease_consistent CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    CONSTRAINT report_publications_notion_fields_consistent CHECK (
        (notion_page_id IS NULL AND notion_page_url IS NULL)
        OR (notion_page_id IS NOT NULL AND notion_page_url IS NOT NULL)
    ),
    CONSTRAINT report_publications_state_consistent CHECK (
        (
            status = 'PENDING'
            AND notion_page_id IS NULL
            AND slack_message_ts IS NULL
            AND completed_at IS NULL
            AND failed_at IS NULL
        ) OR (
            status = 'NOTION_PUBLISHED'
            AND notion_page_id IS NOT NULL
            AND slack_message_ts IS NULL
            AND completed_at IS NULL
            AND failed_at IS NULL
        ) OR (
            status = 'COMPLETE'
            AND notion_page_id IS NOT NULL
            AND slack_message_ts IS NOT NULL
            AND completed_at IS NOT NULL
            AND failed_at IS NULL
        ) OR (
            status = 'FAILED'
            AND slack_message_ts IS NULL
            AND completed_at IS NULL
            AND failed_at IS NOT NULL
            AND last_error_code IS NOT NULL
        )
    ),
    CONSTRAINT report_publications_time_order CHECK (
        updated_at >= created_at
        AND next_attempt_at >= created_at
        AND (lease_expires_at IS NULL OR lease_expires_at >= created_at)
        AND (completed_at IS NULL OR completed_at >= created_at)
        AND (failed_at IS NULL OR failed_at >= created_at)
    )
);

CREATE INDEX report_publications_due_idx
    ON report_publications (next_attempt_at, created_at, id)
    WHERE status IN ('PENDING', 'NOTION_PUBLISHED');

INSERT INTO report_publications (
    id,
    tenant_id,
    incident_id,
    report_revision_id,
    status,
    next_attempt_at,
    created_at,
    updated_at
)
SELECT
    'publication:' || revision.id,
    revision.tenant_id,
    revision.incident_id,
    revision.id,
    'PENDING',
    revision.approved_at,
    revision.approved_at,
    revision.approved_at
FROM report_revisions revision
WHERE revision.status = 'APPROVED'
ON CONFLICT (tenant_id, incident_id, report_revision_id) DO NOTHING;
