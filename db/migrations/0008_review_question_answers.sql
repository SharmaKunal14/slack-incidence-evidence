-- Preserves reviewer answers to AI-generated open questions as part of each
-- immutable report revision. Existing revisions remain valid with no answers.
--
-- Production migrations are forward-only. A development-only rollback, before
-- any answer is approved or published, is:
--   DROP TABLE report_revision_question_answers;
-- This rollback destroys human-authored review content and must never run after
-- publication.

CREATE TABLE report_revision_question_answers (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    report_draft_id TEXT NOT NULL,
    report_revision_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    answer TEXT NOT NULL
        CHECK (char_length(btrim(answer)) BETWEEN 1 AND 4000),
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT report_revision_question_answers_revision_fk
        FOREIGN KEY (
            tenant_id,
            incident_id,
            report_draft_id,
            report_revision_id
        ) REFERENCES report_revisions(
            tenant_id,
            incident_id,
            report_draft_id,
            id
        )
        ON DELETE CASCADE,
    CONSTRAINT report_revision_question_answers_question_fk
        FOREIGN KEY (tenant_id, incident_id, question_id)
        REFERENCES analysis_open_questions(tenant_id, incident_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT report_revision_question_answers_tenant_incident_id_unique
        UNIQUE (tenant_id, incident_id, id),
    CONSTRAINT report_revision_question_answers_revision_question_unique
        UNIQUE (tenant_id, incident_id, report_revision_id, question_id)
);

CREATE INDEX report_revision_question_answers_revision_idx
    ON report_revision_question_answers (
        tenant_id,
        incident_id,
        report_revision_id,
        created_at,
        id
    );
