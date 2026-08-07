import type { Pool, QueryResultRow } from 'pg';
import { z } from 'zod';
import type { Clock } from '../../application/ports/clock.js';
import {
  SlackInstallationCredentialResolutionError,
  type RuntimeSlackInstallation,
  type SlackInstallationCredentialResolver,
} from '../../application/ports/slack-installation-credential-resolver.js';
import {
  slackInstallationCredentialSchema,
  slackInstallationSecretArnSchema,
} from '../../application/onboarding/slack-installation.js';
import type { SecretsManagerSecretReader } from '../secrets/secrets-manager-secret-reader.js';

const workspaceIdSchema = z.string().regex(/^T[A-Z0-9]{1,63}$/u);
const botUserIdSchema = z.string().regex(/^[UW][A-Z0-9]{1,63}$/u);

interface InstallationRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly team_id: string;
  readonly bot_user_id: string;
  readonly status: string;
  readonly revoked_at: Date | null;
  readonly credential_secret_arn: string | null;
  readonly credential_expires_at: Date | null;
}

/** Resolves one active workspace installation without a legacy-token fallback. */
export class PostgresSecretsSlackInstallationCredentialResolver implements SlackInstallationCredentialResolver {
  public constructor(
    private readonly database: Pick<Pool, 'query'>,
    private readonly secrets: Pick<SecretsManagerSecretReader, 'readString'>,
    private readonly clock: Clock,
  ) {}

  public async resolve(workspaceId: string): Promise<RuntimeSlackInstallation> {
    const parsedWorkspaceId = workspaceIdSchema.safeParse(workspaceId);
    if (!parsedWorkspaceId.success) {
      throw new SlackInstallationCredentialResolutionError(
        'SLACK_INSTALLATION_NOT_FOUND',
        false,
      );
    }

    let result;
    try {
      result = await this.database.query<InstallationRow>(
        `
          SELECT
            tenant_id,
            team_id,
            bot_user_id,
            status,
            revoked_at,
            credential_secret_arn,
            credential_expires_at
          FROM slack_installations
          WHERE team_id = $1
          LIMIT 2
        `,
        [parsedWorkspaceId.data],
      );
    } catch (error) {
      throw new SlackInstallationCredentialResolutionError(
        'SLACK_INSTALLATION_LOOKUP_FAILED',
        true,
        { cause: error },
      );
    }

    if (result.rows.length !== 1) {
      throw new SlackInstallationCredentialResolutionError(
        'SLACK_INSTALLATION_NOT_FOUND',
        false,
      );
    }
    const installation = result.rows[0];
    if (
      installation === undefined ||
      installation.tenant_id !== parsedWorkspaceId.data ||
      installation.team_id !== parsedWorkspaceId.data ||
      !botUserIdSchema.safeParse(installation.bot_user_id).success
    ) {
      throw new SlackInstallationCredentialResolutionError(
        'SLACK_INSTALLATION_CREDENTIAL_MISMATCH',
        false,
      );
    }
    if (installation.status !== 'ACTIVE' || installation.revoked_at !== null) {
      throw new SlackInstallationCredentialResolutionError(
        'SLACK_INSTALLATION_NOT_ACTIVE',
        false,
      );
    }
    const secretArn = slackInstallationSecretArnSchema.safeParse(
      installation.credential_secret_arn,
    );
    if (!secretArn.success) {
      throw new SlackInstallationCredentialResolutionError(
        'SLACK_INSTALLATION_CREDENTIAL_MISSING',
        false,
      );
    }

    let secretValue: string;
    try {
      secretValue = await this.secrets.readString(secretArn.data);
    } catch (error) {
      throw new SlackInstallationCredentialResolutionError(
        'SLACK_INSTALLATION_CREDENTIAL_UNAVAILABLE',
        isRetryableSecretReadError(error),
        { cause: error },
      );
    }

    let rawCredential: unknown;
    try {
      rawCredential = JSON.parse(secretValue) as unknown;
    } catch (error) {
      throw new SlackInstallationCredentialResolutionError(
        'SLACK_INSTALLATION_CREDENTIAL_INVALID',
        false,
        { cause: error },
      );
    }
    const credential =
      slackInstallationCredentialSchema.safeParse(rawCredential);
    if (!credential.success) {
      throw new SlackInstallationCredentialResolutionError(
        'SLACK_INSTALLATION_CREDENTIAL_INVALID',
        false,
      );
    }
    if (
      credential.data.teamId !== installation.team_id ||
      credential.data.botUserId !== installation.bot_user_id ||
      !expiryMetadataMatches(
        installation.credential_expires_at,
        credential.data,
      )
    ) {
      throw new SlackInstallationCredentialResolutionError(
        'SLACK_INSTALLATION_CREDENTIAL_MISMATCH',
        false,
      );
    }
    if (
      credential.data.rotation.mode === 'ROTATING' &&
      Date.parse(credential.data.rotation.expiresAt) <=
        this.clock.now().getTime()
    ) {
      throw new SlackInstallationCredentialResolutionError(
        'SLACK_INSTALLATION_CREDENTIAL_EXPIRED',
        false,
      );
    }

    return {
      workspaceId: installation.team_id,
      botToken: credential.data.accessToken,
    };
  }
}

function expiryMetadataMatches(
  databaseExpiry: Date | null,
  credential: z.output<typeof slackInstallationCredentialSchema>,
): boolean {
  if (credential.rotation.mode === 'LONG_LIVED') {
    return databaseExpiry === null;
  }
  return (
    databaseExpiry instanceof Date &&
    !Number.isNaN(databaseExpiry.getTime()) &&
    databaseExpiry.getTime() === Date.parse(credential.rotation.expiresAt)
  );
}

function isRetryableSecretReadError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return true;
  }
  return ![
    'AccessDeniedException',
    'DecryptionFailure',
    'InvalidRequestException',
    'ResourceNotFoundException',
    'SecretValueUnavailableError',
  ].includes(String(error.name));
}
