import { z } from 'zod';

export const SLACK_REQUIRED_BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'channels:read',
  'chat:write',
  'commands',
  'users:read',
] as const;

export const SLACK_OAUTH_AUTHORIZATION_TTL_SECONDS = 10 * 60;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
const cognitoSubject = z.string().trim().min(1).max(128);
const safeErrorCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u);
const secretsManagerArn = z
  .string()
  .regex(
    /^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/u,
  );

export const SLACK_INSTALLATION_STATUSES = [
  'PENDING',
  'ACTIVE',
  'RECONNECT_REQUIRED',
  'REVOKED',
  'FAILED',
] as const;

export const slackInstallationStatusSchema = z.enum(
  SLACK_INSTALLATION_STATUSES,
);

export type SlackInstallationStatus = z.infer<
  typeof slackInstallationStatusSchema
>;

const printableSecret = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[\x21-\x7e]+$/u);

const slackWorkspaceId = z.string().regex(/^T[A-Z0-9]{1,63}$/u);
const slackUserId = z.string().regex(/^U[A-Z0-9]{1,63}$/u);
const slackAppId = z.string().regex(/^A[A-Z0-9]{1,63}$/u);
const slackEnterpriseId = z.string().regex(/^E[A-Z0-9]{1,63}$/u);

const longLivedCredentialSchema = z
  .object({
    mode: z.literal('LONG_LIVED'),
  })
  .strict();

const rotatingCredentialSchema = z
  .object({
    mode: z.literal('ROTATING'),
    refreshToken: printableSecret,
    expiresAt: z.iso.datetime(),
  })
  .strict();

/** Strict JSON contract stored in the tenant-scoped Secrets Manager secret. */
export const slackInstallationCredentialSchema = z
  .object({
    schemaVersion: z.literal(1),
    teamId: slackWorkspaceId,
    botUserId: slackUserId,
    accessToken: printableSecret,
    rotation: z.discriminatedUnion('mode', [
      longLivedCredentialSchema,
      rotatingCredentialSchema,
    ]),
  })
  .strict();

export type SlackInstallationCredential = z.infer<
  typeof slackInstallationCredentialSchema
>;

const requiredScopesSchema = z
  .array(z.enum(SLACK_REQUIRED_BOT_SCOPES))
  .length(SLACK_REQUIRED_BOT_SCOPES.length)
  .refine(
    (scopes) =>
      scopes.every(
        (scope, index) => scope === SLACK_REQUIRED_BOT_SCOPES[index],
      ),
    'Slack scopes must exactly match the canonical ordered scope set',
  );

export const createSlackOAuthAuthorizationSchema = z
  .object({
    id: z.uuid(),
    stateSha256: sha256Hex,
    browserBindingSha256: sha256Hex,
    cognitoSubject,
    redirectUri: z
      .url()
      .max(2_048)
      .refine((value) => new URL(value).protocol === 'https:', {
        message: 'OAuth redirect URI must use HTTPS',
      }),
    requestedScopes: requiredScopesSchema,
    createdAt: z.date(),
    expiresAt: z.date(),
  })
  .strict()
  .superRefine((value, context) => {
    const lifetimeMilliseconds =
      value.expiresAt.getTime() - value.createdAt.getTime();
    if (
      lifetimeMilliseconds <= 0 ||
      lifetimeMilliseconds > SLACK_OAUTH_AUTHORIZATION_TTL_SECONDS * 1_000
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message:
          'OAuth authorization lifetime must be between 1 and 600 seconds',
      });
    }
  });

export const consumeSlackOAuthAuthorizationSchema = z
  .object({
    stateSha256: sha256Hex,
    browserBindingSha256: sha256Hex,
    cognitoSubject,
    consumedAt: z.date(),
  })
  .strict();

export const completeSlackInstallationSchema = z
  .object({
    authorizationId: z.uuid(),
    installationId: z.string().trim().min(1).max(128),
    cognitoSubject,
    teamId: slackWorkspaceId,
    teamName: z.string().trim().min(1).max(200),
    enterpriseId: slackEnterpriseId.nullable(),
    appId: slackAppId,
    botUserId: slackUserId,
    authedSlackUserId: slackUserId,
    credentialSecretArn: secretsManagerArn,
    credentialExpiresAt: z.date().nullable(),
    grantedScopes: requiredScopesSchema,
    completedAt: z.date(),
  })
  .strict()
  .refine(
    (value) =>
      value.credentialExpiresAt === null ||
      value.credentialExpiresAt.getTime() > value.completedAt.getTime(),
    {
      path: ['credentialExpiresAt'],
      message: 'Rotating Slack credential must be current at installation',
    },
  );

export const failSlackOAuthAuthorizationSchema = z
  .object({
    authorizationId: z.uuid(),
    cognitoSubject,
    failureCode: safeErrorCode,
    failedAt: z.date(),
  })
  .strict();

const ALLOWED_STATUS_TRANSITIONS: Readonly<
  Record<SlackInstallationStatus, ReadonlySet<SlackInstallationStatus>>
> = {
  PENDING: new Set(['ACTIVE', 'FAILED']),
  ACTIVE: new Set(['RECONNECT_REQUIRED', 'REVOKED']),
  RECONNECT_REQUIRED: new Set(['ACTIVE', 'REVOKED']),
  REVOKED: new Set(['PENDING']),
  FAILED: new Set(['PENDING', 'REVOKED']),
};

export function isSlackInstallationTransitionAllowed(
  from: SlackInstallationStatus,
  to: SlackInstallationStatus,
): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from].has(to);
}

export function isSlackInstallationCredentialCurrent(
  credential: SlackInstallationCredential,
  at: Date,
): boolean {
  if (Number.isNaN(at.getTime())) {
    return false;
  }
  return (
    credential.rotation.mode === 'LONG_LIVED' ||
    Date.parse(credential.rotation.expiresAt) > at.getTime()
  );
}
