-- Apply with psql after creating a NOINHERIT, NOSUPERUSER, NOCREATEDB,
-- NOCREATEROLE, NOREPLICATION login outside source control:
--
--   psql "$ADMIN_DATABASE_URL" \
--     --set=review_role=incident_review_api \
--     --file=db/security/review_api_grants.sql
--
-- The role password belongs in Secrets Manager, never in this file. The role
-- also needs CONNECT on the target database, granted by its database owner.

\if :{?review_role}
\else
  \echo 'review_role psql variable is required'
  \quit 3
\endif

GRANT USAGE ON SCHEMA public TO :"review_role";

GRANT SELECT ON TABLE
  public.schema_migrations,
  reviewer_memberships,
  incidents,
  incident_report_drafts,
  incident_report_sections,
  incident_report_statements,
  report_statement_claim_links,
  report_statement_timeline_event_links,
  claims,
  claim_evidence_links,
  timeline_events,
  timeline_event_evidence_links,
  source_artifacts,
  incident_sources,
  source_coverage_manifests,
  analysis_open_questions,
  report_revisions,
  report_revision_question_answers
TO :"review_role";

GRANT INSERT ON TABLE
  report_revisions,
  report_revision_statements,
  report_revision_claim_links,
  report_revision_timeline_event_links,
  report_revision_question_answers,
  report_approvals,
  report_publications,
  audit_events
TO :"review_role";

GRANT UPDATE (
  status,
  approved_by_subject,
  approved_at
) ON report_revisions TO :"review_role";

GRANT UPDATE (
  status,
  updated_at,
  version
) ON incidents TO :"review_role";

-- The API must never provision reviewers, change model drafts, delete evidence,
-- or execute publication. It may only enqueue the approved immutable revision
-- in the same transaction; external publication remains a separate worker
-- concern.
