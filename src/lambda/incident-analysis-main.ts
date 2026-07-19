import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Context } from 'aws-lambda';
import { Pool } from 'pg';
import { AnalyzeIncidentEvidence } from '../application/analyze-incident-evidence.js';
import { systemClock } from '../application/ports/clock.js';
import { uuidGenerator } from '../application/ports/id-generator.js';
import { loadIncidentAnalysisLambdaEnvironment } from '../config/environment.js';
import {
  parseDatabaseConnectionSecret,
  parseOpenAiApiSecret,
} from '../config/runtime-secrets.js';
import { PostgresIncidentAnalysisRepository } from '../infrastructure/postgres/incident-analysis-repository.js';
import { PostgresIncidentRepository } from '../infrastructure/postgres/incident-repository.js';
import { assertDatabaseSchemaCompatible } from '../infrastructure/postgres/schema-compatibility.js';
import { SecretsManagerSecretReader } from '../infrastructure/secrets/secrets-manager-secret-reader.js';
import { ResponsesIncidentAnalyzer } from '../integrations/openai/responses-incident-analyzer.js';
import { createLogger } from '../observability/logger.js';
import {
  createIncidentAnalysisHandler,
  type IncidentAnalysisHandler,
} from './incident-analysis-handler.js';

const environment = loadIncidentAnalysisLambdaEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
let handlerPromise: Promise<IncidentAnalysisHandler> | undefined;

/** Step Functions composition root for durable, structured AI extraction. */
export async function handler(
  event: unknown,
  context: Context,
): Promise<unknown> {
  context.callbackWaitsForEmptyEventLoop = false;
  let runtimeHandler: IncidentAnalysisHandler;
  try {
    runtimeHandler = await getHandler();
  } catch (error) {
    logger.error(
      { err: error },
      'Incident analysis Lambda initialization failed',
    );
    throw new LambdaInitializationError();
  }
  try {
    return await runtimeHandler(event);
  } catch (error) {
    logger.error({ err: error }, 'Incident analysis task failed');
    throw new IncidentAnalysisTaskError();
  }
}

function getHandler(): Promise<IncidentAnalysisHandler> {
  handlerPromise ??= buildHandler().catch((error: unknown) => {
    handlerPromise = undefined;
    throw error;
  });
  return handlerPromise;
}

async function buildHandler(): Promise<IncidentAnalysisHandler> {
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
      application_name: 'incident-evidence-copilot-analysis',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: environment.DATABASE_POOL_MAX,
    });
    database.on('error', (error) => {
      logger.error({ err: error }, 'idle PostgreSQL client failed');
    });
    await assertDatabaseSchemaCompatible(database);

    const useCase = new AnalyzeIncidentEvidence(
      new PostgresIncidentAnalysisRepository(database),
      new PostgresIncidentRepository(database),
      new ResponsesIncidentAnalyzer({
        apiKey: openAiSecret.apiKey,
        model: environment.OPENAI_MODEL,
        timeoutMilliseconds: environment.OPENAI_TIMEOUT_MS,
        maxOutputTokens: environment.OPENAI_MAX_OUTPUT_TOKENS,
      }),
      systemClock,
      uuidGenerator,
      {
        model: environment.OPENAI_MODEL,
        maxArtifacts: environment.ANALYSIS_MAX_ARTIFACTS,
        maxInputCharacters: environment.ANALYSIS_MAX_INPUT_CHARACTERS,
        maxAttempts: environment.ANALYSIS_MAX_ATTEMPTS,
        leaseSeconds: environment.ANALYSIS_LEASE_SECONDS,
      },
    );
    return createIncidentAnalysisHandler({ analyzer: useCase, logger });
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
    super('Incident analysis Lambda initialization failed');
    this.name = 'LambdaInitializationError';
  }
}

class IncidentAnalysisTaskError extends Error {
  public constructor() {
    super('Incident analysis task failed');
    this.name = 'IncidentAnalysisTaskError';
  }
}
