import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
  Context,
} from 'aws-lambda';
import { Pool } from 'pg';
import { SlackOnboardingStartService } from '../application/onboarding/slack-onboarding-service.js';
import { systemClock } from '../application/ports/clock.js';
import { uuidGenerator } from '../application/ports/id-generator.js';
import { loadSlackOnboardingStartLambdaEnvironment } from '../config/environment.js';
import { parseDatabaseConnectionSecret } from '../config/runtime-secrets.js';
import { PostgresSlackOnboardingRepository } from '../infrastructure/postgres/slack-onboarding-repository.js';
import { assertDatabaseSchemaCompatible } from '../infrastructure/postgres/schema-compatibility.js';
import { SecretsManagerSecretReader } from '../infrastructure/secrets/secrets-manager-secret-reader.js';
import { NodeSecureTokenGenerator } from '../infrastructure/security/node-secure-token-generator.js';
import { createLogger } from '../observability/logger.js';
import {
  createSlackOnboardingStartHandler,
  type SlackOnboardingStartHandler,
} from './slack-onboarding-start-handler.js';

const environment = loadSlackOnboardingStartLambdaEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
let handlerPromise: Promise<SlackOnboardingStartHandler> | undefined;

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  context: Context,
): Promise<APIGatewayProxyResultV2> {
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    return (await getHandler())(event);
  } catch {
    logger.error('Slack onboarding start Lambda initialization failed');
    throw new SlackOnboardingInitializationError();
  }
}

function getHandler(): Promise<SlackOnboardingStartHandler> {
  handlerPromise ??= buildHandler().catch((error: unknown) => {
    handlerPromise = undefined;
    throw error;
  });
  return handlerPromise;
}

async function buildHandler(): Promise<SlackOnboardingStartHandler> {
  const secrets = new SecretsManagerClient({ region: environment.AWS_REGION });
  let database: Pool | undefined;
  try {
    const connection = parseDatabaseConnectionSecret(
      await new SecretsManagerSecretReader(secrets).readString(
        environment.DATABASE_SECRET_ARN,
      ),
    );
    secrets.destroy();
    database = createDatabasePool(connection);
    await assertDatabaseSchemaCompatible(database);
    const onboarding = new SlackOnboardingStartService(
      new PostgresSlackOnboardingRepository(database),
      new NodeSecureTokenGenerator(),
      uuidGenerator,
      systemClock,
      {
        clientId: environment.SLACK_OAUTH_CLIENT_ID,
        redirectUri: environment.SLACK_OAUTH_REDIRECT_URI,
      },
    );
    return createSlackOnboardingStartHandler({ onboarding, logger });
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
    application_name: 'incident-copilot-slack-onboarding-start',
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
