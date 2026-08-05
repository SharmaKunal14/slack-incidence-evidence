-- Slack may return W-prefixed user IDs for Enterprise Grid members. Migration
-- 0012 admitted only U-prefixed IDs, so widen the identity constraint without
-- changing any existing values or installation authority.
--
-- Rollback is safe only after confirming no W-prefixed identities exist:
--   ALTER TABLE reviewer_memberships
--     DROP CONSTRAINT reviewer_memberships_slack_user_id_valid;
--   ALTER TABLE reviewer_memberships
--     ADD CONSTRAINT reviewer_memberships_slack_user_id_valid CHECK (
--       slack_user_id IS NULL OR slack_user_id ~ '^U[A-Z0-9]{1,63}$'
--     );

ALTER TABLE reviewer_memberships
    DROP CONSTRAINT reviewer_memberships_slack_user_id_valid,
    ADD CONSTRAINT reviewer_memberships_slack_user_id_valid CHECK (
        slack_user_id IS NULL OR slack_user_id ~ '^[UW][A-Z0-9]{1,63}$'
    );
