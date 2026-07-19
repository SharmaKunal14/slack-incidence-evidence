import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Context, ScheduledEvent } from 'aws-lambda';
import { Pool } from 'pg';
import { PublishApprovedReports } from '../application/publish-approved-reports.js';
import { systemClock } from '../application/ports/clock.js';
import type { ApprovedReportPublisher } from '../application/ports/approved-report-publisher.js';
import { loadApprovedReportPublicationLambdaEnvironment } from '../config/environment.js';
import {
  parseDatabaseConnectionSecret,
  parseConfluenceApiSecret,
  parseNotionApiSecret,
  parseSlackBotTokenSecret,
} from '../config/runtime-secrets.js';
import { PostgresApprovedReportPublicationRepository } from '../infrastructure/postgres/approved-report-publication-repository.js';
import { assertDatabaseSchemaCompatible } from '../infrastructure/postgres/schema-compatibility.js';
import { SecretsManagerSecretReader } from '../infrastructure/secrets/secrets-manager-secret-reader.js';
import { ConfluenceApprovedReportPublisher } from '../integrations/confluence/confluence-approved-report-publisher.js';
import { NotionApprovedReportPublisher } from '../integrations/notion/notion-approved-report-publisher.js';
import { SlackWebApiIncidentStatusNotifier } from '../integrations/slack/web-api-incident-status-notifier.js';
import { createLogger } from '../observability/logger.js';
import {
  createApprovedReportPublicationHandler,
  type ApprovedReportPublicationHandler,
} from './approved-report-publication-handler.js';

const environment = loadApprovedReportPublicationLambdaEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
let handlerPromise: Promise<ApprovedReportPublicationHandler> | undefined;

export async function handler(
  event: ScheduledEvent<never>,
  context: Context,
): Promise<void> {
  context.callbackWaitsForEmptyEventLoop = false;
  let runtimeHandler: ApprovedReportPublicationHandler;
  try {
    runtimeHandler = await getHandler();
  } catch (error) {
    logger.error(
      { err: error },
      'Approved report publication Lambda initialization failed',
    );
    throw new LambdaInitializationError();
  }
  await runtimeHandler(event);
}

function getHandler(): Promise<ApprovedReportPublicationHandler> {
  handlerPromise ??= buildHandler().catch((error: unknown) => {
    handlerPromise = undefined;
    throw error;
  });
  return handlerPromise;
}

async function buildHandler(): Promise<ApprovedReportPublicationHandler> {
  const secrets = new SecretsManagerClient({ region: environment.AWS_REGION });
  let database: Pool | undefined;
  try {
    const secretReader = new SecretsManagerSecretReader(secrets);
    const publisherSecretArn =
      environment.REPORT_PUBLICATION_PROVIDER === 'NOTION'
        ? environment.NOTION_API_SECRET_ARN
        : environment.CONFLUENCE_API_SECRET_ARN;
    const [databaseValue, slackValue, publisherValue] = await Promise.all([
      secretReader.readString(environment.DATABASE_SECRET_ARN),
      secretReader.readString(environment.SLACK_BOT_TOKEN_SECRET_ARN),
      secretReader.readString(publisherSecretArn),
    ]);
    const databaseSecret = parseDatabaseConnectionSecret(databaseValue);
    const slackSecret = parseSlackBotTokenSecret(slackValue);
    let publisher: ApprovedReportPublisher;
    if (environment.REPORT_PUBLICATION_PROVIDER === 'NOTION') {
      const notionSecret = parseNotionApiSecret(publisherValue);
      publisher = new NotionApprovedReportPublisher({
        apiToken: notionSecret.apiToken,
        dataSourceId: environment.NOTION_DATA_SOURCE_ID,
        titleProperty: environment.NOTION_TITLE_PROPERTY,
        incidentIdProperty: environment.NOTION_INCIDENT_ID_PROPERTY,
        timeoutMs: environment.NOTION_TIMEOUT_MS,
      });
    } else {
      const confluenceSecret = parseConfluenceApiSecret(publisherValue);
      publisher = new ConfluenceApprovedReportPublisher({
        baseUrl: environment.CONFLUENCE_BASE_URL,
        ...(environment.CONFLUENCE_CLOUD_ID === undefined
          ? {}
          : { cloudId: environment.CONFLUENCE_CLOUD_ID }),
        email: confluenceSecret.email,
        apiToken: confluenceSecret.apiToken,
        spaceId: environment.CONFLUENCE_SPACE_ID,
        ...(environment.CONFLUENCE_PARENT_PAGE_ID === undefined
          ? {}
          : { parentPageId: environment.CONFLUENCE_PARENT_PAGE_ID }),
        timeoutMs: environment.CONFLUENCE_TIMEOUT_MS,
      });
    }
    secrets.destroy();

    database = new Pool({
      host: environment.DATABASE_HOST,
      port: environment.DATABASE_PORT,
      database: environment.DATABASE_NAME,
      user: databaseSecret.username,
      password: databaseSecret.password,
      ssl: environment.DATABASE_SSL
        ? { ca: databaseSecret.caCertificate, rejectUnauthorized: true }
        : false,
      application_name: 'incident-evidence-copilot-publication',
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
    await assertDatabaseSchemaCompatible(database);

    const publications = new PublishApprovedReports(
      new PostgresApprovedReportPublicationRepository(database),
      publisher,
      new SlackWebApiIncidentStatusNotifier({
        workspaceId: slackSecret.workspaceId,
        botToken: slackSecret.botToken,
      }),
      systemClock,
    );
    return createApprovedReportPublicationHandler({
      publications,
      logger,
      maxJobs: environment.PUBLICATION_BATCH_SIZE,
      maxAttempts: environment.PUBLICATION_MAX_ATTEMPTS,
      leaseSeconds: environment.PUBLICATION_LEASE_SECONDS,
      retryBaseSeconds: environment.PUBLICATION_RETRY_BASE_SECONDS,
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
    super('Approved report publication Lambda initialization failed');
    this.name = 'LambdaInitializationError';
  }
}
