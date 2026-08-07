import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from 'aws-lambda';
import { Pool } from 'pg';
import { SlackOnboardingService } from '../application/onboarding/slack-onboarding-service.js';
import { WorkspaceIdentityCompletionService } from '../application/onboarding/workspace-access-service.js';
import { systemClock } from '../application/ports/clock.js';
import { uuidGenerator } from '../application/ports/id-generator.js';
import { loadSlackOnboardingCallbackLambdaEnvironment } from '../config/environment.js';
import {
  parseDatabaseConnectionSecret,
  parseSlackOAuthAppSecret,
} from '../config/runtime-secrets.js';
import { PostgresSlackOnboardingRepository } from '../infrastructure/postgres/slack-onboarding-repository.js';
import { PostgresWorkspaceAccessRepository } from '../infrastructure/postgres/workspace-access-repository.js';
import { assertDatabaseSchemaCompatible } from '../infrastructure/postgres/schema-compatibility.js';
import { SecretsManagerSecretReader } from '../infrastructure/secrets/secrets-manager-secret-reader.js';
import { SecretsManagerSlackInstallationCredentialStore } from '../infrastructure/secrets/secrets-manager-slack-installation-credential-store.js';
import { NodeSecureTokenGenerator } from '../infrastructure/security/node-secure-token-generator.js';
import { WebApiSlackOAuthProvider } from '../integrations/slack/web-api-slack-oauth-provider.js';
import { WebApiSlackIdentityProvider } from '../integrations/slack/web-api-slack-identity-provider.js';
import { createLogger } from '../observability/logger.js';
import {
  createSlackOnboardingCallbackHandler,
  type SlackOnboardingCallbackHandler,
} from './slack-onboarding-callback-handler.js';

const environment = loadSlackOnboardingCallbackLambdaEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
let handlerPromise: Promise<SlackOnboardingCallbackHandler> | undefined;

export async function handler(
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> {
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    return (await getHandler())(event);
  } catch {
    logger.error('Slack onboarding callback Lambda initialization failed');
    throw new SlackOnboardingInitializationError();
  }
}

function getHandler(): Promise<SlackOnboardingCallbackHandler> {
  handlerPromise ??= buildHandler().catch((error: unknown) => {
    handlerPromise = undefined;
    throw error;
  });
  return handlerPromise;
}

async function buildHandler(): Promise<SlackOnboardingCallbackHandler> {
  const secrets = new SecretsManagerClient({ region: environment.AWS_REGION });
  let database: Pool | undefined;
  try {
    const reader = new SecretsManagerSecretReader(secrets);
    const [databaseSecret, oauthSecret] = await Promise.all([
      reader.readString(environment.DATABASE_SECRET_ARN),
      reader.readString(environment.SLACK_OAUTH_APP_SECRET_ARN),
    ]);
    const connection = parseDatabaseConnectionSecret(databaseSecret);
    const oauth = parseSlackOAuthAppSecret(oauthSecret);
    database = createDatabasePool(connection);
    await assertDatabaseSchemaCompatible(database);
    const onboarding = new SlackOnboardingService(
      new PostgresSlackOnboardingRepository(database),
      new WebApiSlackOAuthProvider(
        {
          clientId: environment.SLACK_OAUTH_CLIENT_ID,
          clientSecret: oauth.clientSecret,
        },
        { timeoutMs: environment.SLACK_OAUTH_TIMEOUT_MS },
      ),
      new SecretsManagerSlackInstallationCredentialStore(secrets, {
        secretNamePrefix: environment.SLACK_INSTALLATION_SECRET_PREFIX,
        kmsKeyId: environment.SLACK_INSTALLATION_KMS_KEY_ARN,
      }),
      new NodeSecureTokenGenerator(),
      uuidGenerator,
      systemClock,
      {
        clientId: environment.SLACK_OAUTH_CLIENT_ID,
        expectedAppId: environment.SLACK_OAUTH_APP_ID,
        redirectUri: environment.SLACK_OAUTH_REDIRECT_URI,
      },
    );
    const workspaceIdentity = new WorkspaceIdentityCompletionService(
      new PostgresWorkspaceAccessRepository(database),
      new WebApiSlackIdentityProvider(
        environment.SLACK_OAUTH_CLIENT_ID,
        oauth.clientSecret,
        { timeoutMs: environment.SLACK_OAUTH_TIMEOUT_MS },
      ),
      systemClock,
    );
    return createSlackOnboardingCallbackHandler({
      onboarding,
      workspaceIdentity,
      logger,
      successRedirectUrl: environment.ONBOARDING_SUCCESS_REDIRECT_URL,
      failureRedirectUrl: environment.ONBOARDING_FAILURE_REDIRECT_URL,
      identitySuccessRedirectUrl: environment.IDENTITY_SUCCESS_REDIRECT_URL,
      identityFailureRedirectUrl: environment.IDENTITY_FAILURE_REDIRECT_URL,
    });
  } catch (error) {
    await database?.end();
    secrets.destroy();
    throw error;
  }
}

function createDatabasePool(connection: {
  readonly username: string;
  readonly password: string;
  readonly caCertificate: string;
}): Pool {
  const pool = new Pool({
    host: environment.DATABASE_HOST,
    port: environment.DATABASE_PORT,
    database: environment.DATABASE_NAME,
    user: connection.username,
    password: connection.password,
    ssl: environment.DATABASE_SSL
      ? { ca: connection.caCertificate, rejectUnauthorized: true }
      : false,
    application_name: 'incident-copilot-slack-onboarding-callback',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    idle_in_transaction_session_timeout: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    max: environment.DATABASE_POOL_MAX,
  });
  pool.on('error', () =>
    logger.error('Idle onboarding PostgreSQL client failed'),
  );
  return pool;
}

class SlackOnboardingInitializationError extends Error {
  public constructor() {
    super('Slack onboarding Lambda initialization failed');
    this.name = 'SlackOnboardingInitializationError';
  }
}
