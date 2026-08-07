import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from 'aws-lambda';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { systemClock } from '../application/ports/clock.js';
import { uuidGenerator } from '../application/ports/id-generator.js';
import {
  RequestIncidentReview,
  RequestScopedIncidentReview,
} from '../application/request-incident-review.js';
import { loadSlackIngressLambdaEnvironment } from '../config/environment.js';
import {
  parseDatabaseConnectionSecret,
  parseSlackSigningSecret,
} from '../config/runtime-secrets.js';
import { PostgresSecretsSlackInstallationCredentialResolver } from '../infrastructure/postgres-secrets/slack-installation-credential-resolver.js';
import { PostgresEligibleIncidentReviewerSource } from '../infrastructure/postgres/eligible-incident-reviewer-source.js';
import { SqsIncidentJobPublisher } from '../infrastructure/queue/sqs-incident-job-publisher.js';
import { SecretsManagerSecretReader } from '../infrastructure/secrets/secrets-manager-secret-reader.js';
import { ResolvingSlackIncidentScopeModal } from '../integrations/slack/resolving-slack-adapters.js';
import { SlackSignatureVerifier } from '../integrations/slack/signature-verifier.js';
import { createLogger } from '../observability/logger.js';
import {
  createSlackIngressHandler,
  type SlackIngressHandler,
} from './slack-ingress-handler.js';

const environment = loadSlackIngressLambdaEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
let handlerPromise: Promise<SlackIngressHandler> | undefined;

/** AWS Lambda composition root for API Gateway HTTP API ingress. */
export async function handler(
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> {
  context.callbackWaitsForEmptyEventLoop = false;
  let runtimeHandler: SlackIngressHandler;
  try {
    runtimeHandler = await getHandler();
  } catch (error) {
    // Initialization errors happen before the boundary handler can return its
    // controlled 503. Log only the allowlisted error shape, then throw a stable
    // error so Lambda/API Gateway records no secret-manager response details.
    logger.error({ err: error }, 'Slack ingress Lambda initialization failed');
    throw new LambdaInitializationError();
  }
  return runtimeHandler(event);
}

function getHandler(): Promise<SlackIngressHandler> {
  handlerPromise ??= buildHandler().catch((error: unknown) => {
    handlerPromise = undefined;
    throw error;
  });
  return handlerPromise;
}

async function buildHandler(): Promise<SlackIngressHandler> {
  const clientConfiguration = {
    region: environment.AWS_REGION,
    ...(environment.AWS_ENDPOINT_URL === undefined
      ? {}
      : { endpoint: environment.AWS_ENDPOINT_URL }),
  };
  const secrets = new SecretsManagerClient(clientConfiguration);
  const sqs = new SQSClient(clientConfiguration);
  let database: Pool | undefined;

  try {
    const secretReader = new SecretsManagerSecretReader(secrets);
    const [signingSecretValue, databaseSecretValue] = await Promise.all([
      secretReader.readString(environment.SLACK_SIGNING_SECRET_ARN),
      secretReader.readString(environment.DATABASE_SECRET_ARN),
    ]);
    const signingSecret = parseSlackSigningSecret(signingSecretValue);
    const databaseSecret = parseDatabaseConnectionSecret(databaseSecretValue);
    database = new Pool({
      host: environment.DATABASE_HOST,
      port: environment.DATABASE_PORT,
      database: environment.DATABASE_NAME,
      user: databaseSecret.username,
      password: databaseSecret.password,
      ssl: environment.DATABASE_SSL
        ? { ca: databaseSecret.caCertificate, rejectUnauthorized: true }
        : false,
      application_name: 'incident-evidence-copilot-slack-ingress',
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
      max: environment.DATABASE_POOL_MAX,
    });
    database.on('error', (error) => {
      logger.error({ err: error }, 'idle PostgreSQL client failed');
    });
    const publisher = new SqsIncidentJobPublisher(
      sqs,
      environment.INCIDENT_QUEUE_URL,
    );
    const requestIncidentReview = new RequestIncidentReview(
      publisher,
      systemClock,
      uuidGenerator,
    );

    return createSlackIngressHandler({
      clock: systemClock,
      logger,
      signatureVerifier: new SlackSignatureVerifier(
        signingSecret.signingSecret,
      ),
      requestIncidentReview,
      requestScopedIncidentReview: new RequestScopedIncidentReview(
        publisher,
        systemClock,
        uuidGenerator,
      ),
      incidentScopeModal: new ResolvingSlackIncidentScopeModal(
        new PostgresSecretsSlackInstallationCredentialResolver(
          database,
          secretReader,
          systemClock,
        ),
        new PostgresEligibleIncidentReviewerSource(database),
      ),
      evidenceRetentionDays: environment.EVIDENCE_RETENTION_DAYS,
    });
  } catch (error) {
    if (database !== undefined) {
      await database.end();
    }
    secrets.destroy();
    sqs.destroy();
    throw error;
  }
}

class LambdaInitializationError extends Error {
  public constructor() {
    super('Slack ingress Lambda initialization failed');
    this.name = 'LambdaInitializationError';
  }
}
