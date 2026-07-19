import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SFNClient } from '@aws-sdk/client-sfn';
import { Pool } from 'pg';
import { systemClock } from '../application/ports/clock.js';
import { uuidGenerator } from '../application/ports/id-generator.js';
import { ProcessIncidentReview } from '../application/process-incident-review.js';
import { loadIncidentWorkerLambdaEnvironment } from '../config/environment.js';
import {
  parseDatabaseConnectionSecret,
  parseSlackBotTokenSecret,
} from '../config/runtime-secrets.js';
import { PostgresIncidentRepository } from '../infrastructure/postgres/incident-repository.js';
import { assertDatabaseSchemaCompatible } from '../infrastructure/postgres/schema-compatibility.js';
import { SecretsManagerSecretReader } from '../infrastructure/secrets/secrets-manager-secret-reader.js';
import { SfnIncidentWorkflowStarter } from '../infrastructure/workflow/sfn-incident-workflow-starter.js';
import { SlackWebApiIncidentStatusNotifier } from '../integrations/slack/web-api-incident-status-notifier.js';
import { createLogger } from '../observability/logger.js';
import {
  createIncidentWorkerHandler,
  type IncidentWorkerHandler,
} from './incident-worker-handler.js';

const environment = loadIncidentWorkerLambdaEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
let handlerPromise: Promise<IncidentWorkerHandler> | undefined;

/** AWS Lambda composition root for the SQS FIFO event-source mapping. */
export async function handler(
  event: SQSEvent,
  context: Context,
): Promise<SQSBatchResponse> {
  // The pool is deliberately reused by a warm Lambda execution environment.
  context.callbackWaitsForEmptyEventLoop = false;
  let runtimeHandler: IncidentWorkerHandler;
  try {
    runtimeHandler = await getHandler();
  } catch (error) {
    logger.error(
      { err: error },
      'incident worker Lambda initialization failed',
    );
    throw new LambdaInitializationError();
  }
  return runtimeHandler(event);
}

function getHandler(): Promise<IncidentWorkerHandler> {
  handlerPromise ??= buildHandler().catch((error: unknown) => {
    handlerPromise = undefined;
    throw error;
  });
  return handlerPromise;
}

async function buildHandler(): Promise<IncidentWorkerHandler> {
  const clientConfiguration = {
    region: environment.AWS_REGION,
    ...(environment.AWS_ENDPOINT_URL === undefined
      ? {}
      : { endpoint: environment.AWS_ENDPOINT_URL }),
  };
  const secrets = new SecretsManagerClient(clientConfiguration);
  const stateMachines = new SFNClient(clientConfiguration);
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
      application_name: 'incident-evidence-copilot-lambda-worker',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: environment.DATABASE_POOL_MAX,
    });
    database.on('error', (error) => {
      logger.error({ err: error }, 'idle PostgreSQL client failed');
    });

    // SQS retains the record while an incompatible release is blocked from
    // starting work; retries can recover after migrations complete.
    await assertDatabaseSchemaCompatible(database);
    const processIncidentReview = new ProcessIncidentReview(
      new PostgresIncidentRepository(database),
      systemClock,
      uuidGenerator,
    );
    const workflowStarter = new SfnIncidentWorkflowStarter(
      stateMachines,
      environment.INCIDENT_WORKFLOW_STATE_MACHINE_ARN,
    );
    const statusNotifier = new SlackWebApiIncidentStatusNotifier(
      slackBotSecret,
    );

    return createIncidentWorkerHandler({
      processIncidentReview,
      workflowStarter,
      statusNotifier,
      logger,
    });
  } catch (error) {
    if (database !== undefined) {
      await database.end();
    }
    secrets.destroy();
    stateMachines.destroy();
    throw error;
  }
}

class LambdaInitializationError extends Error {
  public constructor() {
    super('Incident worker Lambda initialization failed');
    this.name = 'LambdaInitializationError';
  }
}
