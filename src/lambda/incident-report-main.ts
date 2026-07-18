import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Context } from 'aws-lambda';
import { Pool } from 'pg';
import { GenerateIncidentReport } from '../application/generate-incident-report.js';
import { systemClock } from '../application/ports/clock.js';
import { uuidGenerator } from '../application/ports/id-generator.js';
import { loadIncidentReportLambdaEnvironment } from '../config/environment.js';
import {
  parseDatabaseConnectionSecret,
  parseOpenAiApiSecret,
} from '../config/runtime-secrets.js';
import { PostgresIncidentReportRepository } from '../infrastructure/postgres/incident-report-repository.js';
import { PostgresIncidentRepository } from '../infrastructure/postgres/incident-repository.js';
import { SecretsManagerSecretReader } from '../infrastructure/secrets/secrets-manager-secret-reader.js';
import { ResponsesIncidentReportGenerator } from '../integrations/openai/responses-incident-report-generator.js';
import { createLogger } from '../observability/logger.js';
import {
  createIncidentReportHandler,
  type IncidentReportHandler,
} from './incident-report-handler.js';

const environment = loadIncidentReportLambdaEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
let handlerPromise: Promise<IncidentReportHandler> | undefined;

/** Step Functions composition root for source-linked report generation. */
export async function handler(
  event: unknown,
  context: Context,
): Promise<unknown> {
  context.callbackWaitsForEmptyEventLoop = false;
  let runtimeHandler: IncidentReportHandler;
  try {
    runtimeHandler = await getHandler();
  } catch (error) {
    logger.error(
      { err: error },
      'Incident report Lambda initialization failed',
    );
    throw new LambdaInitializationError();
  }
  try {
    return await runtimeHandler(event);
  } catch (error) {
    logger.error({ err: error }, 'Incident report task failed');
    throw new IncidentReportTaskError();
  }
}

function getHandler(): Promise<IncidentReportHandler> {
  handlerPromise ??= buildHandler().catch((error: unknown) => {
    handlerPromise = undefined;
    throw error;
  });
  return handlerPromise;
}

async function buildHandler(): Promise<IncidentReportHandler> {
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
    const [databaseSecretValue, openAiSecretValue] = await Promise.all([
      secretReader.readString(environment.DATABASE_SECRET_ARN),
      secretReader.readString(environment.OPENAI_API_SECRET_ARN),
    ]);
    const connectionSecret = parseDatabaseConnectionSecret(databaseSecretValue);
    const openAiSecret = parseOpenAiApiSecret(openAiSecretValue);
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
      application_name: 'incident-evidence-copilot-report',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: environment.DATABASE_POOL_MAX,
    });
    database.on('error', (error) => {
      logger.error({ err: error }, 'idle PostgreSQL client failed');
    });
    await database.query('SELECT 1 FROM incident_report_drafts LIMIT 1');

    const useCase = new GenerateIncidentReport(
      new PostgresIncidentReportRepository(database),
      new PostgresIncidentRepository(database),
      new ResponsesIncidentReportGenerator({
        apiKey: openAiSecret.apiKey,
        model: environment.OPENAI_MODEL,
        timeoutMilliseconds: environment.OPENAI_REPORT_TIMEOUT_MS,
        maxOutputTokens: environment.OPENAI_REPORT_MAX_OUTPUT_TOKENS,
      }),
      systemClock,
      uuidGenerator,
      {
        model: environment.OPENAI_MODEL,
        maxSources: environment.REPORT_MAX_SOURCES,
        maxInputCharacters: environment.REPORT_MAX_INPUT_CHARACTERS,
        maxAttempts: environment.REPORT_MAX_ATTEMPTS,
        leaseSeconds: environment.REPORT_LEASE_SECONDS,
      },
    );
    return createIncidentReportHandler({ generator: useCase, logger });
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
    super('Incident report Lambda initialization failed');
    this.name = 'LambdaInitializationError';
  }
}

class IncidentReportTaskError extends Error {
  public constructor() {
    super('Incident report task failed');
    this.name = 'IncidentReportTaskError';
  }
}
