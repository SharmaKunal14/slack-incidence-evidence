-- Apply with psql after creating a NOINHERIT, NOSUPERUSER, NOCREATEDB,
-- NOCREATEROLE, NOREPLICATION login outside source control:
--
--   psql "$ADMIN_DATABASE_URL" \
--     --set=onboarding_role=incident_slack_onboarding \
--     --file=db/security/slack_onboarding_grants.sql

\if :{?onboarding_role}
\else
  \echo 'onboarding_role psql variable is required'
  \quit 3
\endif

GRANT USAGE ON SCHEMA public TO :"onboarding_role";

GRANT SELECT ON TABLE
  public.schema_migrations,
  tenants,
  reviewer_memberships,
  slack_installations,
  slack_oauth_authorizations
TO :"onboarding_role";

GRANT INSERT ON TABLE
  tenants,
  reviewer_memberships,
  slack_installations,
  slack_oauth_authorizations,
  audit_events
TO :"onboarding_role";

GRANT UPDATE (
  display_name,
  updated_at
) ON tenants TO :"onboarding_role";

GRANT UPDATE (
  slack_user_id,
  updated_at
) ON reviewer_memberships TO :"onboarding_role";

GRANT UPDATE (
  enterprise_id,
  app_id,
  bot_user_id,
  installed_by_user_id,
  bot_token_ciphertext,
  encryption_key_id,
  granted_scopes,
  updated_at,
  revoked_at,
  status,
  credential_secret_arn,
  credential_expires_at,
  installed_by_cognito_subject,
  last_error_code,
  version
) ON slack_installations TO :"onboarding_role";

GRANT UPDATE (
  status,
  consumed_at,
  failure_code,
  failed_at,
  completed_at,
  completed_installation_id,
  completion_kind
) ON slack_oauth_authorizations TO :"onboarding_role";

-- This role cannot read stored Slack credentials from Secrets Manager, modify
-- incident evidence or reports, grant arbitrary reviewer access, or delete data.
