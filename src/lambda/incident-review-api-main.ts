import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
  Context,
} from 'aws-lambda';
import { Pool } from 'pg';
import {
  ApproveReportRevision,
  CreateReportRevision,
  GetIncidentReview,
  ListIncidentReviews,
} from '../application/review-incident.js';
import { systemClock } from '../application/ports/clock.js';
import { uuidGenerator } from '../application/ports/id-generator.js';
import { loadIncidentReviewApiLambdaEnvironment } from '../config/environment.js';
import { parseDatabaseConnectionSecret } from '../config/runtime-secrets.js';
import { PostgresIncidentReviewRepository } from '../infrastructure/postgres/incident-review-repository.js';
import { SecretsManagerSecretReader } from '../infrastructure/secrets/secrets-manager-secret-reader.js';
import { createLogger } from '../observability/logger.js';
import {
  createIncidentReviewApiHandler,
  type IncidentReviewApiHandler,
} from './incident-review-api-handler.js';

const environment = loadIncidentReviewApiLambdaEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
let handlerPromise: Promise<IncidentReviewApiHandler> | undefined;

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  context: Context,
): Promise<APIGatewayProxyResultV2> {
  context.callbackWaitsForEmptyEventLoop = false;
  let runtimeHandler: IncidentReviewApiHandler;
  try {
    runtimeHandler = await getHandler();
  } catch (error) {
    logger.error(
      { err: error },
      'Incident review API Lambda initialization failed',
    );
    throw new LambdaInitializationError();
  }
  return runtimeHandler(event);
}

function getHandler(): Promise<IncidentReviewApiHandler> {
  handlerPromise ??= buildHandler().catch((error: unknown) => {
    handlerPromise = undefined;
    throw error;
  });
  return handlerPromise;
}

async function buildHandler(): Promise<IncidentReviewApiHandler> {
  const secrets = new SecretsManagerClient({ region: environment.AWS_REGION });
  let database: Pool | undefined;
  try {
    const connectionSecret = parseDatabaseConnectionSecret(
      await new SecretsManagerSecretReader(secrets).readString(
        environment.DATABASE_SECRET_ARN,
      ),
    );
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
      application_name: 'incident-evidence-copilot-review-api',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      idle_in_transaction_session_timeout: 10_000,
      query_timeout: 10_000,
      statement_timeout: 10_000,
      max: environment.DATABASE_POOL_MAX,
    });
    database.on('error', (error) => {
      logger.error({ err: error }, 'idle PostgreSQL client failed');
    });
    await database.query('SELECT 1 FROM reviewer_memberships LIMIT 1');
    const repository = new PostgresIncidentReviewRepository(database);
    return createIncidentReviewApiHandler({
      listReviews: new ListIncidentReviews(repository),
      getReview: new GetIncidentReview(repository),
      createRevision: new CreateReportRevision(
        repository,
        systemClock,
        uuidGenerator,
      ),
      approveRevision: new ApproveReportRevision(
        repository,
        systemClock,
        uuidGenerator,
      ),
      logger,
      maxBodyBytes: environment.REVIEW_API_MAX_BODY_BYTES,
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
    super('Incident review API Lambda initialization failed');
    this.name = 'LambdaInitializationError';
  }
}
