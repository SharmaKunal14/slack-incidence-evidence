-- Adds structured evidence links for open questions and permits reviewers to
-- add evidence-linked statements without mutating the immutable AI draft.
--
-- Production migrations are forward-only. A development-only rollback, before
-- this release creates reviewer content, is:
--   DROP TABLE analysis_open_question_evidence_links;
--   DELETE FROM report_revision_statements WHERE decision = 'ADD';
--   ALTER TABLE report_revision_statements ALTER COLUMN original_report_statement_id SET NOT NULL;
-- Restoring the previous decision/content checks is then required. Never roll
-- this migration back after reviewer-authored statements have been published.

CREATE TABLE analysis_open_question_evidence_links (
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    open_question_id TEXT NOT NULL,
    source_artifact_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (
        tenant_id,
        incident_id,
        open_question_id,
        source_artifact_id
    ),
    CONSTRAINT analysis_open_question_evidence_links_question_fk
        FOREIGN KEY (tenant_id, incident_id, open_question_id)
        REFERENCES analysis_open_questions(tenant_id, incident_id, id)
        ON DELETE CASCADE,
    CONSTRAINT analysis_open_question_evidence_links_source_fk
        FOREIGN KEY (tenant_id, incident_id, source_artifact_id)
        REFERENCES source_artifacts(tenant_id, incident_id, id)
        ON DELETE CASCADE
);

CREATE INDEX analysis_open_question_evidence_links_source_idx
    ON analysis_open_question_evidence_links (
        tenant_id,
        incident_id,
        source_artifact_id
    );

ALTER TABLE report_revision_statements
    ALTER COLUMN original_report_statement_id DROP NOT NULL;

ALTER TABLE report_revision_statements
    DROP CONSTRAINT report_revision_statements_decision_check;

ALTER TABLE report_revision_statements
    ADD CONSTRAINT report_revision_statements_decision_valid
        CHECK (decision IN ('KEEP', 'EDIT', 'EXCLUDE', 'ADD'));

ALTER TABLE report_revision_statements
    DROP CONSTRAINT report_revision_statements_content_consistent;

ALTER TABLE report_revision_statements
    ADD CONSTRAINT report_revision_statements_content_consistent CHECK (
        (
            decision = 'EXCLUDE'
            AND original_report_statement_id IS NOT NULL
            AND statement IS NULL
            AND classification IS NULL
        ) OR (
            decision IN ('KEEP', 'EDIT')
            AND original_report_statement_id IS NOT NULL
            AND statement IS NOT NULL
            AND classification IS NOT NULL
            AND char_length(btrim(statement)) BETWEEN 1 AND 4000
            AND classification IN (
                'DIRECTLY_OBSERVED',
                'CORROBORATED',
                'PARTICIPANT_ASSERTION',
                'HYPOTHESIS',
                'CORRELATED_INFERENCE',
                'DISPUTED',
                'UNKNOWN',
                'HUMAN_CONFIRMED'
            )
        ) OR (
            decision = 'ADD'
            AND original_report_statement_id IS NULL
            AND statement IS NOT NULL
            AND classification IS NOT NULL
            AND char_length(btrim(statement)) BETWEEN 1 AND 4000
            AND classification IN (
                'DIRECTLY_OBSERVED',
                'CORROBORATED',
                'PARTICIPANT_ASSERTION',
                'HYPOTHESIS',
                'CORRELATED_INFERENCE',
                'DISPUTED',
                'UNKNOWN',
                'HUMAN_CONFIRMED'
            )
        )
    );
