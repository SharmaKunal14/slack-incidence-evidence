-- Apply with psql after creating a NOINHERIT, NOSUPERUSER, NOCREATEDB,
-- NOCREATEROLE, NOREPLICATION login outside source control:
--
--   psql "$ADMIN_DATABASE_URL" \
--     --set=publication_role=incident_publication_worker \
--     --file=db/security/publication_worker_grants.sql
--
-- The role password belongs in Secrets Manager, never in this file. The role
-- also needs CONNECT on the target database, granted by its database owner.

\if :{?publication_role}
\else
  \echo 'publication_role psql variable is required'
  \quit 3
\endif

GRANT USAGE ON SCHEMA public TO :"publication_role";

GRANT SELECT ON TABLE
  public.schema_migrations,
  report_publications,
  report_revisions,
  report_revision_statements,
  report_revision_question_answers,
  analysis_open_questions,
  incident_report_drafts,
  incidents,
  slack_installations
TO :"publication_role";

GRANT UPDATE (
  status,
  attempt_count,
  next_attempt_at,
  lease_owner,
  lease_expires_at,
  publisher,
  published_page_id,
  published_page_url,
  slack_message_ts,
  last_error_code,
  updated_at,
  completed_at,
  failed_at
) ON report_publications TO :"publication_role";

-- The worker cannot approve reports, alter report content, grant reviewer
-- access, modify incidents, or delete evidence.
