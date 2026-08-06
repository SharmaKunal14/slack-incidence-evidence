-- PostgreSQL rejects regular-expression repetition bounds above 255. The
-- original `{1,512}` secret-name bound therefore raised an error whenever a
-- non-null Secrets Manager ARN was checked. Preserve the character whitelist
-- in the regex and enforce the AWS secret-name limit with char_length instead.
--
-- Rollback restores the original definition only for forensic comparison; it
-- reintroduces the runtime error and must not be used on a working environment:
--   ALTER TABLE slack_installations
--     DROP CONSTRAINT slack_installations_secret_arn_valid,
--     ADD CONSTRAINT slack_installations_secret_arn_valid CHECK (
--       credential_secret_arn IS NULL
--       OR credential_secret_arn ~ '^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$'
--     );

ALTER TABLE slack_installations
    DROP CONSTRAINT slack_installations_secret_arn_valid,
    ADD CONSTRAINT slack_installations_secret_arn_valid CHECK (
        credential_secret_arn IS NULL
        OR (
            credential_secret_arn ~ '^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$'
            AND char_length(
                split_part(credential_secret_arn, ':secret:', 2)
            ) BETWEEN 1 AND 512
        )
    );
