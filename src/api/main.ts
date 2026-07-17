import { SQSClient } from '@aws-sdk/client-sqs';
import { loadApiEnvironment } from '../config/environment.js';
import { systemClock } from '../application/ports/clock.js';
import { uuidGenerator } from '../application/ports/id-generator.js';
import { RequestIncidentReview } from '../application/request-incident-review.js';
import { SqsIncidentJobPublisher } from '../infrastructure/queue/sqs-incident-job-publisher.js';
import { SlackSignatureVerifier } from '../integrations/slack/signature-verifier.js';
import { createLogger } from '../observability/logger.js';
import { buildApi } from './server.js';

const environment = loadApiEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
const sqs = new SQSClient({
  region: environment.AWS_REGION,
  ...(environment.AWS_ENDPOINT_URL === undefined
    ? {}
    : { endpoint: environment.AWS_ENDPOINT_URL }),
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
const app = buildApi({
  logger,
  clock: systemClock,
  signatureVerifier: new SlackSignatureVerifier(
    environment.SLACK_SIGNING_SECRET,
  ),
  requestIncidentReview,
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'API shutdown requested');
  await app.close();
  sqs.destroy();
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({ host: environment.API_HOST, port: environment.API_PORT });
  logger.info(
    { host: environment.API_HOST, port: environment.API_PORT },
    'incident API listening',
  );
} catch (error) {
  logger.fatal({ err: error }, 'incident API failed to start');
  process.exitCode = 1;
}
