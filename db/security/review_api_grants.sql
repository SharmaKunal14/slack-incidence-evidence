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
  tenants,
  reviewer_memberships,
  workspace_invitations,
  slack_installations,
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
  source_collection_runs,
  source_collection_checkpoints,
  source_coverage_manifests,
  incident_analysis_runs,
  analysis_open_questions,
  report_revisions,
  report_revision_question_answers
TO :"review_role";

GRANT INSERT ON TABLE
  workspace_invitations,
  slack_identity_authorizations,
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
  reviewer_user_id,
  assigned_reviewer_subject,
  updated_at,
  version
) ON incidents TO :"review_role";

GRANT UPDATE (
  status,
  updated_at,
  version
) ON incident_sources TO :"review_role";

GRANT UPDATE (
  status,
  collected_message_count,
  permission_outcome,
  provider_rate_limit_state,
  missing_or_excluded_periods,
  completion_reason,
  failure_reason,
  started_at,
  finished_at,
  updated_at,
  version
) ON source_collection_runs TO :"review_role";

GRANT UPDATE (
  phase,
  anchor_index,
  collection_cursor,
  pages_collected,
  collected_message_count,
  last_collected_at,
  rate_limit_count,
  transient_failure_count,
  rate_limited_until,
  updated_at,
  version
) ON source_collection_checkpoints TO :"review_role";

GRANT UPDATE (
  source_state,
  collected_message_count,
  missing_or_excluded_periods,
  permission_outcome,
  provider_rate_limit_state,
  completion_or_failure_reason,
  updated_at
) ON source_coverage_manifests TO :"review_role";

GRANT UPDATE (
  role,
  status,
  updated_at,
  revoked_at
) ON reviewer_memberships TO :"review_role";

-- The API creates pending, identity-bound invitations and browser-bound Slack
-- identity attempts. It cannot activate a membership; only the callback role
-- can do that after Slack verification. It cannot change model drafts, delete
-- evidence, or execute publication.
