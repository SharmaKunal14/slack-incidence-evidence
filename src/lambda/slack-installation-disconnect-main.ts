import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
  Context,
} from 'aws-lambda';
import { Pool } from 'pg';
import { DisconnectSlackInstallation } from '../application/onboarding/disconnect-slack-installation.js';
import { systemClock } from '../application/ports/clock.js';
import { uuidGenerator } from '../application/ports/id-generator.js';
import { loadSlackInstallationDisconnectLambdaEnvironment } from '../config/environment.js';
import {
  parseDatabaseConnectionSecret,
  parseSlackOAuthAppSecret,
} from '../config/runtime-secrets.js';
import { PostgresSlackInstallationDisconnectionRepository } from '../infrastructure/postgres/slack-installation-disconnection-repository.js';
import { assertDatabaseSchemaCompatible } from '../infrastructure/postgres/schema-compatibility.js';
import { SecretsManagerSecretReader } from '../infrastructure/secrets/secrets-manager-secret-reader.js';
import { SecretsManagerSlackInstallationCredentialLifecycle } from '../infrastructure/secrets/secrets-manager-slack-installation-credential-lifecycle.js';
import { WebApiSlackAppUninstaller } from '../integrations/slack/web-api-slack-app-uninstaller.js';
import { createLogger } from '../observability/logger.js';
import {
  createSlackInstallationDisconnectHandler,
  type SlackInstallationDisconnectHandler,
} from './slack-installation-disconnect-handler.js';

const environment = loadSlackInstallationDisconnectLambdaEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
let handlerPromise: Promise<SlackInstallationDisconnectHandler> | undefined;

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  context: Context,
): Promise<APIGatewayProxyResultV2> {
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    return (await getHandler())(event);
  } catch {
    logger.error('Slack installation disconnect Lambda initialization failed');
    throw new SlackInstallationDisconnectInitializationError();
  }
}

function getHandler(): Promise<SlackInstallationDisconnectHandler> {
  handlerPromise ??= buildHandler().catch((error: unknown) => {
    handlerPromise = undefined;
    throw error;
  });
  return handlerPromise;
}

async function buildHandler(): Promise<SlackInstallationDisconnectHandler> {
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
    const disconnect = new DisconnectSlackInstallation(
      new PostgresSlackInstallationDisconnectionRepository(database),
      new SecretsManagerSlackInstallationCredentialLifecycle(secrets, {
        recoveryWindowDays: environment.SLACK_CREDENTIAL_RECOVERY_WINDOW_DAYS,
      }),
      new WebApiSlackAppUninstaller(
        {
          clientId: environment.SLACK_OAUTH_CLIENT_ID,
          clientSecret: oauth.clientSecret,
        },
        { timeoutMs: environment.SLACK_APP_UNINSTALL_TIMEOUT_MS },
      ),
      systemClock,
      uuidGenerator,
    );
    return createSlackInstallationDisconnectHandler({ disconnect, logger });
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
    application_name: 'incident-copilot-slack-installation-disconnect',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    idle_in_transaction_session_timeout: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    max: environment.DATABASE_POOL_MAX,
  });
  pool.on('error', () =>
    logger.error('Idle Slack disconnect PostgreSQL client failed'),
  );
  return pool;
}

class SlackInstallationDisconnectInitializationError extends Error {
  public constructor() {
    super('Slack installation disconnect Lambda initialization failed');
    this.name = 'SlackInstallationDisconnectInitializationError';
  }
}
