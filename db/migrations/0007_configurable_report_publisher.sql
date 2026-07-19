-- Makes the approved-report publication checkpoint provider-neutral while
-- preserving every Notion publication created by migration 0006.
--
-- Production migrations are forward-only. A development-only rollback is
-- possible only after proving that no row has publisher = 'CONFLUENCE'; rename
-- the page columns back to notion_page_id/notion_page_url and
-- PAGE_PUBLISHED back to NOTION_PUBLISHED before restoring the old checks.

DROP INDEX report_publications_due_idx;

ALTER TABLE report_publications
    DROP CONSTRAINT report_publications_status_check,
    DROP CONSTRAINT report_publications_notion_fields_consistent,
    DROP CONSTRAINT report_publications_state_consistent;

ALTER TABLE report_publications
    RENAME COLUMN notion_page_id TO published_page_id;

ALTER TABLE report_publications
    RENAME COLUMN notion_page_url TO published_page_url;

ALTER TABLE report_publications
    ADD COLUMN publisher TEXT;

-- An attempted Notion request may have succeeded despite an ambiguous network
-- failure. Pin attempted jobs to Notion so a provider switch cannot create the
-- same report in a second system without an explicit operator decision.
UPDATE report_publications
SET publisher = 'NOTION'
WHERE attempt_count > 0
   OR published_page_id IS NOT NULL
   OR status <> 'PENDING';

UPDATE report_publications
SET status = 'PAGE_PUBLISHED'
WHERE status = 'NOTION_PUBLISHED';

ALTER TABLE report_publications
    ADD CONSTRAINT report_publications_status_check
        CHECK (status IN ('PENDING', 'PAGE_PUBLISHED', 'COMPLETE', 'FAILED')),
    ADD CONSTRAINT report_publications_publisher_check
        CHECK (publisher IS NULL OR publisher IN ('NOTION', 'CONFLUENCE')),
    ADD CONSTRAINT report_publications_page_fields_consistent CHECK (
        (
            published_page_id IS NULL
            AND published_page_url IS NULL
        ) OR (
            published_page_id IS NOT NULL
            AND published_page_url IS NOT NULL
            AND publisher IS NOT NULL
        )
    ),
    ADD CONSTRAINT report_publications_state_consistent CHECK (
        (
            status = 'PENDING'
            AND published_page_id IS NULL
            AND slack_message_ts IS NULL
            AND completed_at IS NULL
            AND failed_at IS NULL
        ) OR (
            status = 'PAGE_PUBLISHED'
            AND publisher IS NOT NULL
            AND published_page_id IS NOT NULL
            AND slack_message_ts IS NULL
            AND completed_at IS NULL
            AND failed_at IS NULL
        ) OR (
            status = 'COMPLETE'
            AND publisher IS NOT NULL
            AND published_page_id IS NOT NULL
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
    );

CREATE INDEX report_publications_due_idx
    ON report_publications (next_attempt_at, created_at, id)
    WHERE status IN ('PENDING', 'PAGE_PUBLISHED');
