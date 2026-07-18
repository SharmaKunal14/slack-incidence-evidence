-- Adds tenant-authorized human review, immutable report revisions, and an
-- approval record. AI-generated drafts remain immutable and cannot satisfy any
-- human actor foreign key.
--
-- Production migrations are forward-only. A development-only rollback, before
-- an approval is consumed by a publisher, is:
--   DROP TABLE report_approvals;
--   DROP TABLE report_revision_timeline_event_links;
--   DROP TABLE report_revision_claim_links;
--   DROP TABLE report_revision_statements;
--   DROP TABLE report_revisions;
--   DROP TABLE reviewer_memberships;
--   ALTER TABLE incident_report_statements
--     DROP CONSTRAINT incident_report_statements_draft_id_unique;
-- This rollback destroys human decisions and must never run after publication.

CREATE TABLE reviewer_memberships (
    tenant_id TEXT NOT NULL,
    cognito_subject TEXT NOT NULL
        CHECK (char_length(cognito_subject) BETWEEN 1 AND 128),
    role TEXT NOT NULL CHECK (role IN ('REVIEWER', 'ADMIN')),
    status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'REVOKED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, cognito_subject),
    CONSTRAINT reviewer_memberships_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    CONSTRAINT reviewer_memberships_state_consistent CHECK (
        (status = 'ACTIVE' AND revoked_at IS NULL)
        OR (status = 'REVOKED' AND revoked_at IS NOT NULL)
    ),
    CONSTRAINT reviewer_memberships_time_order CHECK (
        updated_at >= created_at
        AND (revoked_at IS NULL OR revoked_at >= created_at)
    )
);

CREATE INDEX reviewer_memberships_subject_active_idx
    ON reviewer_memberships (cognito_subject, tenant_id)
    WHERE status = 'ACTIVE';

ALTER TABLE incident_report_statements
    ADD CONSTRAINT incident_report_statements_draft_id_unique
        UNIQUE (tenant_id, incident_id, report_draft_id, id);

CREATE TABLE report_revisions (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    report_draft_id TEXT NOT NULL,
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    status TEXT NOT NULL CHECK (status IN ('DRAFT', 'APPROVED')),
    created_by_subject TEXT NOT NULL,
    client_request_id TEXT NOT NULL CHECK (char_length(client_request_id) BETWEEN 1 AND 128),
    request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    acknowledged_contradictions BOOLEAN NOT NULL,
    acknowledged_open_questions BOOLEAN NOT NULL,
    statement_count INTEGER NOT NULL CHECK (statement_count > 0),
    rendered_markdown TEXT NOT NULL CHECK (char_length(rendered_markdown) BETWEEN 1 AND 200000),
    content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL,
    approved_by_subject TEXT,
    approved_at TIMESTAMPTZ,
    CONSTRAINT report_revisions_draft_fk
        FOREIGN KEY (tenant_id, incident_id, report_draft_id)
        REFERENCES incident_report_drafts(tenant_id, incident_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT report_revisions_creator_fk
        FOREIGN KEY (tenant_id, created_by_subject)
        REFERENCES reviewer_memberships(tenant_id, cognito_subject)
        ON DELETE RESTRICT,
    CONSTRAINT report_revisions_approver_fk
        FOREIGN KEY (tenant_id, approved_by_subject)
        REFERENCES reviewer_memberships(tenant_id, cognito_subject)
        ON DELETE RESTRICT,
    CONSTRAINT report_revisions_tenant_incident_id_unique
        UNIQUE (tenant_id, incident_id, id),
    CONSTRAINT report_revisions_draft_id_unique
        UNIQUE (tenant_id, incident_id, report_draft_id, id),
    CONSTRAINT report_revisions_draft_number_unique
        UNIQUE (tenant_id, incident_id, report_draft_id, revision_number),
    CONSTRAINT report_revisions_request_unique
        UNIQUE (tenant_id, created_by_subject, client_request_id),
    CONSTRAINT report_revisions_state_consistent CHECK (
        (
            status = 'DRAFT'
            AND approved_by_subject IS NULL
            AND approved_at IS NULL
        ) OR (
            status = 'APPROVED'
            AND approved_by_subject IS NOT NULL
            AND approved_at IS NOT NULL
        )
    ),
    CONSTRAINT report_revisions_approval_time_order CHECK (
        approved_at IS NULL OR approved_at >= created_at
    )
);

CREATE UNIQUE INDEX report_revisions_one_approved_incident_idx
    ON report_revisions (tenant_id, incident_id)
    WHERE status = 'APPROVED';

CREATE INDEX report_revisions_incident_created_idx
    ON report_revisions (tenant_id, incident_id, created_at DESC, id);

CREATE TABLE report_revision_statements (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    report_draft_id TEXT NOT NULL,
    report_revision_id TEXT NOT NULL,
    original_report_statement_id TEXT NOT NULL,
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
    decision TEXT NOT NULL CHECK (decision IN ('KEEP', 'EDIT', 'EXCLUDE')),
    statement TEXT,
    classification TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT report_revision_statements_revision_fk
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
    CONSTRAINT report_revision_statements_original_fk
        FOREIGN KEY (
            tenant_id,
            incident_id,
            report_draft_id,
            original_report_statement_id
        ) REFERENCES incident_report_statements(
            tenant_id,
            incident_id,
            report_draft_id,
            id
        )
        ON DELETE RESTRICT,
    CONSTRAINT report_revision_statements_tenant_incident_id_unique
        UNIQUE (tenant_id, incident_id, id),
    CONSTRAINT report_revision_statements_original_unique
        UNIQUE (
            tenant_id,
            incident_id,
            report_revision_id,
            original_report_statement_id
        ),
    CONSTRAINT report_revision_statements_position_unique
        UNIQUE (tenant_id, incident_id, report_revision_id, section_type, position),
    CONSTRAINT report_revision_statements_content_consistent CHECK (
        (
            decision = 'EXCLUDE'
            AND statement IS NULL
            AND classification IS NULL
        ) OR (
            decision IN ('KEEP', 'EDIT')
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
    )
);

CREATE TABLE report_revision_claim_links (
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    report_revision_statement_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (
        tenant_id,
        incident_id,
        report_revision_statement_id,
        claim_id
    ),
    CONSTRAINT report_revision_claim_links_statement_fk
        FOREIGN KEY (tenant_id, incident_id, report_revision_statement_id)
        REFERENCES report_revision_statements(tenant_id, incident_id, id)
        ON DELETE CASCADE,
    CONSTRAINT report_revision_claim_links_claim_fk
        FOREIGN KEY (tenant_id, incident_id, claim_id)
        REFERENCES claims(tenant_id, incident_id, id)
        ON DELETE RESTRICT
);

CREATE TABLE report_revision_timeline_event_links (
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    report_revision_statement_id TEXT NOT NULL,
    timeline_event_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (
        tenant_id,
        incident_id,
        report_revision_statement_id,
        timeline_event_id
    ),
    CONSTRAINT report_revision_timeline_links_statement_fk
        FOREIGN KEY (tenant_id, incident_id, report_revision_statement_id)
        REFERENCES report_revision_statements(tenant_id, incident_id, id)
        ON DELETE CASCADE,
    CONSTRAINT report_revision_timeline_links_event_fk
        FOREIGN KEY (tenant_id, incident_id, timeline_event_id)
        REFERENCES timeline_events(tenant_id, incident_id, id)
        ON DELETE RESTRICT
);

CREATE TABLE report_approvals (
    id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    report_revision_id TEXT NOT NULL,
    approved_by_subject TEXT NOT NULL,
    client_request_id TEXT NOT NULL CHECK (char_length(client_request_id) BETWEEN 1 AND 128),
    approved_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT report_approvals_revision_fk
        FOREIGN KEY (tenant_id, incident_id, report_revision_id)
        REFERENCES report_revisions(tenant_id, incident_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT report_approvals_reviewer_fk
        FOREIGN KEY (tenant_id, approved_by_subject)
        REFERENCES reviewer_memberships(tenant_id, cognito_subject)
        ON DELETE RESTRICT,
    CONSTRAINT report_approvals_revision_unique
        UNIQUE (tenant_id, incident_id, report_revision_id),
    CONSTRAINT report_approvals_request_unique
        UNIQUE (tenant_id, approved_by_subject, client_request_id)
);

CREATE INDEX report_approvals_incident_time_idx
    ON report_approvals (tenant_id, incident_id, approved_at DESC, id);
