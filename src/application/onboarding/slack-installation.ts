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
