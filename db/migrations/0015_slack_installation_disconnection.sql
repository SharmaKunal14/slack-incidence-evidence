-- Stage 6 adds an explicit fail-closed state while Slack revocation and
-- recoverable Secrets Manager deletion are in progress. Deploying this
-- additive constraint change before the application is backward compatible;
-- the previous release never writes DISCONNECTING.
--
-- Rollback requires every DISCONNECTING row to be resolved first:
--   SELECT team_id FROM slack_installations WHERE status = 'DISCONNECTING';
-- Then restore the previous five-value status constraint.

ALTER TABLE slack_installations
    DROP CONSTRAINT slack_installations_status_valid,
    ADD CONSTRAINT slack_installations_status_valid CHECK (
        status IN (
            'PENDING',
            'ACTIVE',
            'RECONNECT_REQUIRED',
            'DISCONNECTING',
            'REVOKED',
            'FAILED'
        )
    );
