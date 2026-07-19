import { SQSClient } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { ProcessIncidentReview } from '../application/process-incident-review.js';
import { systemClock } from '../application/ports/clock.js';
import { uuidGenerator } from '../application/ports/id-generator.js';
import { loadWorkerEnvironment } from '../config/environment.js';
import { PostgresIncidentRepository } from '../infrastructure/postgres/incident-repository.js';
import { assertDatabaseSchemaCompatible } from '../infrastructure/postgres/schema-compatibility.js';
import { SqsIncidentJobConsumer } from '../infrastructure/queue/sqs-incident-job-consumer.js';
import { createLogger } from '../observability/logger.js';

const environment = loadWorkerEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
const abortController = new AbortController();
const sqs = new SQSClient({
  region: environment.AWS_REGION,
  ...(environment.AWS_ENDPOINT_URL === undefined
    ? {}
    : { endpoint: environment.AWS_ENDPOINT_URL }),
});
const database = new Pool({
  connectionString: environment.DATABASE_URL,
  application_name: 'incident-evidence-copilot-worker',
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  max: 10,
});

database.on('error', (error) => {
  logger.error({ err: error }, 'idle PostgreSQL client failed');
});

const processIncidentReview = new ProcessIncidentReview(
  new PostgresIncidentRepository(database),
  systemClock,
  uuidGenerator,
);
const consumer = new SqsIncidentJobConsumer({
  client: sqs,
  queueUrl: environment.INCIDENT_QUEUE_URL,
  waitTimeSeconds: environment.SQS_WAIT_TIME_SECONDS,
  logger,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'worker shutdown requested');
    abortController.abort();
  });
}

try {
  // Fail before polling if the database or migrations are unavailable. Leaving
  // SQS messages untouched allows another healthy worker to process them.
  await assertDatabaseSchemaCompatible(database);
  await consumer.run(async (job) => {
    const result = await processIncidentReview.execute(job);
    logger.info(
      {
        incidentId: result.incidentId,
        jobId: job.jobId,
        outcome: result.outcome,
      },
      'incident workflow accepted',
    );
  }, abortController.signal);
} catch (error) {
  logger.fatal({ err: error }, 'incident worker stopped unexpectedly');
  process.exitCode = 1;
} finally {
  sqs.destroy();
  await database.end();
}
