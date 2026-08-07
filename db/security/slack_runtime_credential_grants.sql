-- Apply with psql after creating a NOINHERIT, NOSUPERUSER, NOCREATEDB,
-- NOCREATEROLE, NOREPLICATION login outside source control:
--
--   psql "$ADMIN_DATABASE_URL" \
--     --set=slack_runtime_role=incident_slack_runtime \
--     --file=db/security/slack_runtime_credential_grants.sql
--
-- Store the role password in Secrets Manager. The role also needs CONNECT on
-- the target database, granted by its database owner.

\if :{?slack_runtime_role}
\else
  \echo 'slack_runtime_role psql variable is required'
  \quit 3
\endif

GRANT USAGE ON SCHEMA public TO :"slack_runtime_role";

GRANT SELECT ON TABLE
  public.schema_migrations,
  slack_installations
TO :"slack_runtime_role";

-- Runtime processes can select installation metadata only. They cannot mutate
-- tenants, memberships, OAuth attempts, installations, incidents, or reports.
