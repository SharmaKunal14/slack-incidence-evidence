import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Context } from 'aws-lambda';
import { Pool } from 'pg';
import { NotifyIncidentReviewReady } from '../application/notify-incident-review-ready.js';
import { loadIncidentReviewNotificationLambdaEnvironment } from '../config/environment.js';
import {
  parseDatabaseConnectionSecret,
  parseSlackBotTokenSecret,
} from '../config/runtime-secrets.js';
import { PostgresIncidentRepository } from '../infrastructure/postgres/incident-repository.js';
import { PostgresIncidentReportRepository } from '../infrastructure/postgres/incident-report-repository.js';
import { assertDatabaseSchemaCompatible } from '../infrastructure/postgres/schema-compatibility.js';
import { SecretsManagerSecretReader } from '../infrastructure/secrets/secrets-manager-secret-reader.js';
import { SlackWebApiIncidentStatusNotifier } from '../integrations/slack/web-api-incident-status-notifier.js';
import { createLogger } from '../observability/logger.js';
import {
  createIncidentReviewNotificationHandler,
  type IncidentReviewNotificationHandler,
} from './incident-review-notification-handler.js';

const environment = loadIncidentReviewNotificationLambdaEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
let handlerPromise: Promise<IncidentReviewNotificationHandler> | undefined;

export async function handler(
  event: unknown,
  context: Context,
): Promise<unknown> {
  context.callbackWaitsForEmptyEventLoop = false;
  let runtimeHandler: IncidentReviewNotificationHandler;
  try {
    runtimeHandler = await getHandler();
  } catch (error) {
    logger.error(
      { err: error },
      'Incident review notification Lambda initialization failed',
    );
    throw new LambdaInitializationError();
  }
  try {
    return await runtimeHandler(event);
  } catch (error) {
    logger.error({ err: error }, 'Incident review notification task failed');
    throw new IncidentReviewNotificationTaskError();
  }
}

function getHandler(): Promise<IncidentReviewNotificationHandler> {
  handlerPromise ??= buildHandler().catch((error: unknown) => {
    handlerPromise = undefined;
    throw error;
  });
  return handlerPromise;
}

async function buildHandler(): Promise<IncidentReviewNotificationHandler> {
  const clientConfiguration = {
    region: environment.AWS_REGION,
    ...(environment.AWS_ENDPOINT_URL === undefined
      ? {}
      : { endpoint: environment.AWS_ENDPOINT_URL }),
  };
  const secrets = new SecretsManagerClient(clientConfiguration);
  let database: Pool | undefined;
  try {
    const secretReader = new SecretsManagerSecretReader(secrets);
    const [databaseSecretValue, slackSecretValue] = await Promise.all([
      secretReader.readString(environment.DATABASE_SECRET_ARN),
      secretReader.readString(environment.SLACK_BOT_TOKEN_SECRET_ARN),
    ]);
    const connectionSecret = parseDatabaseConnectionSecret(databaseSecretValue);
    const slackSecret = parseSlackBotTokenSecret(slackSecretValue);
    secrets.destroy();
    database = new Pool({
      host: environment.DATABASE_HOST,
      port: environment.DATABASE_PORT,
      database: environment.DATABASE_NAME,
      user: connectionSecret.username,
      password: connectionSecret.password,
      ssl: environment.DATABASE_SSL
        ? { ca: connectionSecret.caCertificate, rejectUnauthorized: true }
        : false,
      application_name: 'incident-evidence-copilot-review-notification',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: environment.DATABASE_POOL_MAX,
    });
    database.on('error', (error) => {
      logger.error({ err: error }, 'idle PostgreSQL client failed');
    });
    await assertDatabaseSchemaCompatible(database);
    const reportDrafts = new PostgresIncidentReportRepository(database);
    const useCase = new NotifyIncidentReviewReady(
      new PostgresIncidentRepository(database),
      reportDrafts,
      new SlackWebApiIncidentStatusNotifier(
        {
          workspaceId: slackSecret.workspaceId,
          botToken: slackSecret.botToken,
        },
        {
          reviewAppBaseUrl: environment.REVIEW_APP_BASE_URL,
        },
      ),
    );
    return createIncidentReviewNotificationHandler({
      notifier: useCase,
      logger,
    });
  } catch (error) {
    if (database !== undefined) {
      await database.end();
    }
    secrets.destroy();
    throw error;
  }
}

class LambdaInitializationError extends Error {
  public constructor() {
    super('Incident review notification Lambda initialization failed');
    this.name = 'LambdaInitializationError';
  }
}

class IncidentReviewNotificationTaskError extends Error {
  public constructor() {
    super('Incident review notification task failed');
    this.name = 'IncidentReviewNotificationTaskError';
  }
}
