import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cognitoSubjectSchema } from '../identity/cognito-subject.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import {
  SlackInstallationCredentialStoreError,
  type SlackInstallationCredentialStore,
} from '../ports/slack-installation-credential-store.js';
import {
  SlackOAuthProviderRequestError,
  type SlackBotIdentity,
  type SlackOAuthGrant,
  type SlackOAuthProvider,
} from '../ports/slack-oauth-provider.js';
import {
  SlackOnboardingRepositoryError,
  type ConsumedSlackOAuthAuthorization,
  type SlackInstallationCompletion,
  type SlackOnboardingRepository,
} from '../ports/slack-onboarding-repository.js';
import type { SecureTokenGenerator } from '../ports/secure-token-generator.js';
import {
  SLACK_OAUTH_AUTHORIZATION_TTL_SECONDS,
  SLACK_REQUIRED_BOT_SCOPES,
  slackInstallationCredentialSchema,
  slackInstallationSecretArnSchema,
} from './slack-installation.js';

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const secureTokenSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const callbackValueSchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[\x21-\x7e]+$/u);
const slackClientIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[0-9.]+$/u);
const slackAppIdSchema = z.string().regex(/^A[A-Z0-9]{1,63}$/u);
const slackUserIdSchema = z.string().regex(/^[UW][A-Z0-9]{1,63}$/u);
const slackTeamIdSchema = z.string().regex(/^T[A-Z0-9]{1,63}$/u);

const oauthGrantSchema = z
  .object({
    appId: slackAppIdSchema,
    teamId: slackTeamIdSchema,
    teamName: z.string().trim().min(1).max(200),
    enterpriseId: z
      .string()
      .regex(/^E[A-Z0-9]{1,63}$/u)
      .nullable(),
    botUserId: slackUserIdSchema,
    authedUserId: slackUserIdSchema,
    accessToken: callbackValueSchema,
    refreshToken: callbackValueSchema.nullable(),
    expiresInSeconds: z.number().int().positive().max(604_800).nullable(),
    grantedScopes: z.array(z.string().trim().min(1).max(128)).max(100),
    isEnterpriseInstall: z.boolean(),
  })
  .strict()
  .refine(
    (grant) =>
      (grant.refreshToken === null) === (grant.expiresInSeconds === null),
    'Slack rotation fields must be present together',
  );

const botIdentitySchema = z
  .object({
    teamId: slackTeamIdSchema,
    userId: slackUserIdSchema,
  })
  .strict();
const completeOnboardingInputSchema = z
  .object({
    state: secureTokenSchema,
    browserBinding: secureTokenSchema,
    code: callbackValueSchema,
  })
  .strict();

export type SlackOnboardingErrorCode =
  | 'OAUTH_STATE_INVALID'
  | 'SLACK_OAUTH_EXCHANGE_FAILED'
  | 'SLACK_APP_MISMATCH'
  | 'SLACK_SCOPES_MISMATCH'
  | 'SLACK_ENTERPRISE_INSTALL_UNSUPPORTED'
  | 'SLACK_BOT_VERIFICATION_FAILED'
  | 'SLACK_WORKSPACE_MISMATCH'
  | 'SLACK_BOT_IDENTITY_MISMATCH'
  | 'SLACK_CREDENTIAL_STORAGE_FAILED'
  | 'SLACK_INSTALLATION_ADMIN_REQUIRED'
  | 'SLACK_IDENTITY_CONFLICT'
  | 'SLACK_INSTALLATION_PERSISTENCE_FAILED'
  | 'ONBOARDING_STATE_PERSISTENCE_FAILED';

export class SlackOnboardingError extends Error {
  public constructor(
    readonly code: SlackOnboardingErrorCode,
    readonly retryable: boolean,
  ) {
    super('Slack onboarding could not be completed');
    this.name = 'SlackOnboardingError';
  }
}

export interface StartedSlackOnboarding {
  readonly authorizationUrl: string;
  readonly browserBinding: string;
  readonly expiresAt: Date;
}

/** Creates a browser-bound Slack authorization without requiring OAuth secrets. */
export class SlackOnboardingStartService {
  private readonly clientId: string;
  private readonly redirectUri: string;

  public constructor(
    private readonly repository: SlackOnboardingRepository,
    private readonly tokenGenerator: SecureTokenGenerator,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    configuration: {
      readonly clientId: string;
      readonly redirectUri: string;
    },
  ) {
    this.clientId = slackClientIdSchema.parse(configuration.clientId);
    this.redirectUri = requireHttpsUrl(configuration.redirectUri);
  }

  public async start(cognitoSubject: string): Promise<StartedSlackOnboarding> {
    return startSlackOnboarding(
      this.repository,
      this.tokenGenerator,
      this.idGenerator,
      this.clock,
      this.clientId,
      this.redirectUri,
      cognitoSubject,
    );
  }
}

/** Coordinates provider and persistence ports without exposing credentials. */
export class SlackOnboardingService {
  private readonly clientId: string;
  private readonly expectedAppId: string;
  private readonly redirectUri: string;

  public constructor(
    private readonly repository: SlackOnboardingRepository,
    private readonly provider: SlackOAuthProvider,
    private readonly credentialStore: SlackInstallationCredentialStore,
    private readonly tokenGenerator: SecureTokenGenerator,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    configuration: {
      readonly clientId: string;
      readonly expectedAppId: string;
      readonly redirectUri: string;
    },
  ) {
    this.clientId = slackClientIdSchema.parse(configuration.clientId);
    this.expectedAppId = slackAppIdSchema.parse(configuration.expectedAppId);
    this.redirectUri = requireHttpsUrl(configuration.redirectUri);
  }

  public async start(cognitoSubject: string): Promise<StartedSlackOnboarding> {
    return startSlackOnboarding(
      this.repository,
      this.tokenGenerator,
      this.idGenerator,
      this.clock,
      this.clientId,
      this.redirectUri,
      cognitoSubject,
    );
  }

  public async complete(input: {
    readonly state: string;
    readonly browserBinding: string;
    readonly code: string;
  }): Promise<SlackInstallationCompletion> {
    const parsedInput = completeOnboardingInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new SlackOnboardingError('OAUTH_STATE_INVALID', false);
    }
    const { state, browserBinding, code } = parsedInput.data;
    const claimedAt = requireValidDate(this.clock.now());
    let authorization;
    try {
      authorization = await this.repository.consumeAuthorization({
        stateSha256: sha256(state),
        browserBindingSha256: sha256(browserBinding),
        consumedAt: claimedAt,
      });
    } catch {
      throw new SlackOnboardingError(
        'ONBOARDING_STATE_PERSISTENCE_FAILED',
        true,
      );
    }
    if (authorization === null) {
      throw new SlackOnboardingError('OAUTH_STATE_INVALID', false);
    }
    if (authorization.status === 'COMPLETED') {
      return authorization.completion;
    }

    try {
      return await this.completeConsumedAuthorization(
        authorization,
        authorization.cognitoSubject,
        code,
      );
    } catch (error) {
      const safeError = normalizeOnboardingError(error);
      try {
        await this.repository.failAuthorization({
          authorizationId: authorization.id,
          cognitoSubject: authorization.cognitoSubject,
          failureCode: safeError.code,
          failedAt: requireValidDate(this.clock.now()),
        });
      } catch {
        throw new SlackOnboardingError(
          'ONBOARDING_STATE_PERSISTENCE_FAILED',
          true,
        );
      }
      throw safeError;
    }
  }

  private async completeConsumedAuthorization(
    authorization: ConsumedSlackOAuthAuthorization,
    subject: string,
    code: string,
  ): Promise<SlackInstallationCompletion> {
    assertCanonicalScopes(authorization.requestedScopes);
    let rawGrant: SlackOAuthGrant;
    try {
      rawGrant = await this.provider.exchangeCode({
        code,
        redirectUri: authorization.redirectUri,
      });
    } catch (error) {
      throw new SlackOnboardingError(
        'SLACK_OAUTH_EXCHANGE_FAILED',
        error instanceof SlackOAuthProviderRequestError && error.retryable,
      );
    }
    const grantResult = oauthGrantSchema.safeParse(rawGrant);
    if (!grantResult.success) {
      throw new SlackOnboardingError('SLACK_OAUTH_EXCHANGE_FAILED', false);
    }
    const grant = grantResult.data;
    if (grant.appId !== this.expectedAppId) {
      throw new SlackOnboardingError('SLACK_APP_MISMATCH', false);
    }
    if (grant.isEnterpriseInstall) {
      throw new SlackOnboardingError(
        'SLACK_ENTERPRISE_INSTALL_UNSUPPORTED',
        false,
      );
    }
    assertCanonicalScopes(grant.grantedScopes);

    let rawIdentity: SlackBotIdentity;
    try {
      rawIdentity = await this.provider.verifyBot(grant.accessToken);
    } catch (error) {
      throw new SlackOnboardingError(
        'SLACK_BOT_VERIFICATION_FAILED',
        error instanceof SlackOAuthProviderRequestError && error.retryable,
      );
    }
    const identityResult = botIdentitySchema.safeParse(rawIdentity);
    if (!identityResult.success) {
      throw new SlackOnboardingError('SLACK_BOT_VERIFICATION_FAILED', false);
    }
    if (identityResult.data.teamId !== grant.teamId) {
      throw new SlackOnboardingError('SLACK_WORKSPACE_MISMATCH', false);
    }
    if (identityResult.data.userId !== grant.botUserId) {
      throw new SlackOnboardingError('SLACK_BOT_IDENTITY_MISMATCH', false);
    }

    const credentialIssuedAt = requireValidDate(this.clock.now());
    const credentialExpiresAt =
      grant.expiresInSeconds === null
        ? null
        : new Date(
            credentialIssuedAt.getTime() + grant.expiresInSeconds * 1_000,
          );
    const credential = slackInstallationCredentialSchema.parse({
      schemaVersion: 1,
      teamId: grant.teamId,
      botUserId: grant.botUserId,
      accessToken: grant.accessToken,
      rotation:
        grant.refreshToken === null || credentialExpiresAt === null
          ? { mode: 'LONG_LIVED' }
          : {
              mode: 'ROTATING',
              refreshToken: grant.refreshToken,
              expiresAt: credentialExpiresAt.toISOString(),
            },
    });
    let secretArn: string;
    try {
      const stored = await this.credentialStore.store({
        authorizationId: authorization.id,
        credential,
      });
      secretArn = slackInstallationSecretArnSchema.parse(stored.secretArn);
    } catch (error) {
      throw new SlackOnboardingError(
        'SLACK_CREDENTIAL_STORAGE_FAILED',
        error instanceof SlackInstallationCredentialStoreError &&
          error.retryable,
      );
    }

    const completedAt = requireValidDate(this.clock.now());
    try {
      return await this.repository.completeInstallation({
        authorizationId: authorization.id,
        installationId: `slack-installation:${z
          .uuid()
          .parse(this.idGenerator.generate())}`,
        cognitoSubject: subject,
        teamId: grant.teamId,
        teamName: grant.teamName,
        enterpriseId: grant.enterpriseId,
        appId: grant.appId,
        botUserId: grant.botUserId,
        authedSlackUserId: grant.authedUserId,
        credentialSecretArn: secretArn,
        credentialExpiresAt,
        grantedScopes: [...SLACK_REQUIRED_BOT_SCOPES],
        authorizationCreatedAt: authorization.createdAt,
        completedAt,
      });
    } catch (error) {
      if (error instanceof SlackOnboardingRepositoryError) {
        if (error.code === 'ADMIN_REQUIRED') {
          throw new SlackOnboardingError(
            'SLACK_INSTALLATION_ADMIN_REQUIRED',
            false,
          );
        }
        if (error.code === 'IDENTITY_CONFLICT') {
          throw new SlackOnboardingError('SLACK_IDENTITY_CONFLICT', false);
        }
      }
      throw new SlackOnboardingError(
        'SLACK_INSTALLATION_PERSISTENCE_FAILED',
        true,
      );
    }
  }
}

async function startSlackOnboarding(
  repository: SlackOnboardingRepository,
  tokenGenerator: SecureTokenGenerator,
  idGenerator: IdGenerator,
  clock: Clock,
  clientId: string,
  redirectUri: string,
  cognitoSubject: string,
): Promise<StartedSlackOnboarding> {
  const subject = cognitoSubjectSchema.parse(cognitoSubject);
  const state = secureTokenSchema.parse(tokenGenerator.generate());
  const browserBinding = secureTokenSchema.parse(tokenGenerator.generate());
  if (state === browserBinding) {
    throw new SlackOnboardingError(
      'ONBOARDING_STATE_PERSISTENCE_FAILED',
      false,
    );
  }
  const authorizationId = z.uuid().parse(idGenerator.generate());
  const createdAt = requireValidDate(clock.now());
  const expiresAt = new Date(
    createdAt.getTime() + SLACK_OAUTH_AUTHORIZATION_TTL_SECONDS * 1_000,
  );
  try {
    await repository.createAuthorization({
      id: authorizationId,
      stateSha256: sha256(state),
      browserBindingSha256: sha256(browserBinding),
      cognitoSubject: subject,
      redirectUri,
      requestedScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      createdAt,
      expiresAt,
    });
  } catch (error) {
    if (
      error instanceof SlackOnboardingRepositoryError &&
      error.code === 'ADMIN_REQUIRED'
    ) {
      throw new SlackOnboardingError(
        'SLACK_INSTALLATION_ADMIN_REQUIRED',
        false,
      );
    }
    throw new SlackOnboardingError('ONBOARDING_STATE_PERSISTENCE_FAILED', true);
  }

  const authorizationUrl = new URL(SLACK_AUTHORIZE_URL);
  authorizationUrl.searchParams.set('client_id', clientId);
  authorizationUrl.searchParams.set(
    'scope',
    SLACK_REQUIRED_BOT_SCOPES.join(','),
  );
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('state', state);
  return {
    authorizationUrl: authorizationUrl.toString(),
    browserBinding,
    expiresAt,
  };
}

function assertCanonicalScopes(scopes: readonly string[]): void {
  const normalized = [...new Set(scopes)].sort();
  const expected = [...SLACK_REQUIRED_BOT_SCOPES].sort();
  if (
    normalized.length !== expected.length ||
    normalized.some((scope, index) => scope !== expected[index])
  ) {
    throw new SlackOnboardingError('SLACK_SCOPES_MISMATCH', false);
  }
}

function normalizeOnboardingError(error: unknown): SlackOnboardingError {
  return error instanceof SlackOnboardingError
    ? error
    : new SlackOnboardingError('SLACK_INSTALLATION_PERSISTENCE_FAILED', true);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireHttpsUrl(value: string): string {
  const parsed = z.url().max(2_048).parse(value);
  if (new URL(parsed).protocol !== 'https:') {
    throw new Error('Slack OAuth redirect URI must use HTTPS');
  }
  return parsed;
}

function requireValidDate(value: Date): Date {
  if (Number.isNaN(value.getTime())) {
    throw new Error('Clock returned an invalid date');
  }
  return value;
}
