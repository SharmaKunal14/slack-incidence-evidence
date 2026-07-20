import type { Context } from 'aws-lambda';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import { CollectSlackThreadPage } from '../application/collect-slack-thread-page.js';
import { CollectSlackSourcePage } from '../application/collect-slack-source-page.js';
import { systemClock } from '../application/ports/clock.js';
import { uuidGenerator } from '../application/ports/id-generator.js';
import { loadSlackEvidenceCollectorLambdaEnvironment } from '../config/environment.js';
import {
  parseDatabaseConnectionSecret,
  parseSlackBotTokenSecret,
} from '../config/runtime-secrets.js';
import { PostgresSlackThreadCollectionRepository } from '../infrastructure/postgres/slack-thread-collection-repository.js';
import { PostgresIncidentSourceCollectionRepository } from '../infrastructure/postgres/incident-source-collection-repository.js';
import { assertDatabaseSchemaCompatible } from '../infrastructure/postgres/schema-compatibility.js';
import { SecretsManagerSecretReader } from '../infrastructure/secrets/secrets-manager-secret-reader.js';
import { SlackThreadWebApiSource } from '../integrations/slack/web-api-slack-thread-source.js';
import { SlackChannelWebApiSource } from '../integrations/slack/web-api-slack-channel-source.js';
import { createLogger } from '../observability/logger.js';
import {
  createSlackEvidenceCollectorHandler,
  type SlackEvidenceCollectorHandler,
} from './slack-evidence-collector-handler.js';

const environment = loadSlackEvidenceCollectorLambdaEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
let handlerPromise: Promise<SlackEvidenceCollectorHandler> | undefined;

/** Step Functions composition root for one checkpointed Slack source page. */
export async function handler(
  event: unknown,
  context: Context,
): Promise<unknown> {
  context.callbackWaitsForEmptyEventLoop = false;
  let runtimeHandler: SlackEvidenceCollectorHandler;
  try {
    runtimeHandler = await getHandler();
  } catch (error) {
    logger.error(
      { err: error },
      'Slack evidence collector Lambda initialization failed',
    );
    throw new LambdaInitializationError();
  }
  try {
    return await runtimeHandler(event);
  } catch (error) {
    logger.error({ err: error }, 'Slack evidence collection task failed');
    throw new SlackEvidenceCollectionTaskError();
  }
}

function getHandler(): Promise<SlackEvidenceCollectorHandler> {
  handlerPromise ??= buildHandler().catch((error: unknown) => {
    handlerPromise = undefined;
    throw error;
  });
  return handlerPromise;
}

async function buildHandler(): Promise<SlackEvidenceCollectorHandler> {
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
    const [databaseSecretValue, slackBotSecretValue] = await Promise.all([
      secretReader.readString(environment.DATABASE_SECRET_ARN),
      secretReader.readString(environment.SLACK_BOT_TOKEN_SECRET_ARN),
    ]);
    const connectionSecret = parseDatabaseConnectionSecret(databaseSecretValue);
    const slackBotSecret = parseSlackBotTokenSecret(slackBotSecretValue);
    secrets.destroy();

    database = new Pool({
      host: environment.DATABASE_HOST,
      port: environment.DATABASE_PORT,
      database: environment.DATABASE_NAME,
      user: connectionSecret.username,
      password: connectionSecret.password,
      ssl: environment.DATABASE_SSL
        ? {
            ca: connectionSecret.caCertificate,
            rejectUnauthorized: true,
          }
        : false,
      application_name: 'incident-evidence-copilot-slack-collector',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: environment.DATABASE_POOL_MAX,
    });
    database.on('error', (error) => {
      logger.error({ err: error }, 'idle PostgreSQL client failed');
    });
    await assertDatabaseSchemaCompatible(database);

    const collector = new CollectSlackThreadPage(
      new PostgresSlackThreadCollectionRepository(database),
      new SlackThreadWebApiSource(slackBotSecret),
      systemClock,
      uuidGenerator,
      environment.EVIDENCE_RETENTION_DAYS,
      environment.SLACK_THREAD_MAX_PAGES,
    );
    const sourceCollector = new CollectSlackSourcePage(
      new PostgresIncidentSourceCollectionRepository(database),
      new SlackChannelWebApiSource(slackBotSecret),
      systemClock,
      uuidGenerator,
      environment.SLACK_THREAD_MAX_PAGES,
    );
    return createSlackEvidenceCollectorHandler({
      collector,
      sourceCollector,
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
    super('Slack evidence collector Lambda initialization failed');
    this.name = 'LambdaInitializationError';
  }
}

class SlackEvidenceCollectionTaskError extends Error {
  public constructor() {
    super('Slack evidence collection task failed');
    this.name = 'SlackEvidenceCollectionTaskError';
  }
}
