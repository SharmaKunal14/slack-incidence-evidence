import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from 'fastify';
import type { Clock } from '../application/ports/clock.js';
import type { RequestIncidentReview } from '../application/request-incident-review.js';
import {
  InvalidSlackPayloadError,
  parseSlackRequest,
} from '../integrations/slack/event-parser.js';
import type { SlackSignatureVerifier } from '../integrations/slack/signature-verifier.js';

export interface ApiDependencies {
  readonly logger: FastifyBaseLogger;
  readonly clock: Clock;
  readonly signatureVerifier: SlackSignatureVerifier;
  readonly requestIncidentReview: RequestIncidentReview;
  readonly readinessCheck?: () => Promise<boolean>;
}

export function buildApi(dependencies: ApiDependencies): FastifyInstance {
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    loggerInstance: dependencies.logger,
    requestIdHeader: 'x-request-id',
    trustProxy: true,
  });

  // Slack signs the exact bytes it sends. Parsing JSON before verification can
  // change whitespace or encoding and invalidate an otherwise authentic request.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.get('/health/live', () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const ready = (await dependencies.readinessCheck?.()) ?? true;
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
    });
  });

  app.post('/integrations/slack/events', async (request, reply) => {
    await handleSlackEvent(request, reply, dependencies);
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'unhandled API request failure');
    void reply.status(500).send({ error: 'internal_server_error' });
  });

  return app;
}

async function handleSlackEvent(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ApiDependencies,
): Promise<void> {
  if (!Buffer.isBuffer(request.body)) {
    await reply.status(415).send({ error: 'unsupported_media_type' });
    return;
  }

  const timestamp = singleHeader(request.headers['x-slack-request-timestamp']);
  const signature = singleHeader(request.headers['x-slack-signature']);
  const verification = dependencies.signatureVerifier.verify({
    rawBody: request.body,
    timestamp,
    signature,
    now: dependencies.clock.now(),
  });

  if (!verification.valid) {
    request.log.warn(
      { verificationFailure: verification.reason },
      'rejected unauthenticated Slack request',
    );
    await reply.status(401).send({ error: 'invalid_slack_signature' });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(request.body.toString('utf8')) as unknown;
  } catch {
    await reply.status(400).send({ error: 'invalid_json' });
    return;
  }

  let parsed;
  try {
    parsed = parseSlackRequest(payload);
  } catch (error) {
    if (error instanceof InvalidSlackPayloadError) {
      await reply.status(400).send({ error: 'invalid_slack_payload' });
      return;
    }
    throw error;
  }

  if (parsed.kind === 'url_verification') {
    await reply.status(200).send({ challenge: parsed.challenge });
    return;
  }

  if (parsed.kind === 'ignored') {
    request.log.debug({ eventType: parsed.eventType }, 'ignored Slack event');
    await reply.status(200).send({ ok: true });
    return;
  }

  try {
    const jobId = await dependencies.requestIncidentReview.execute(parsed);
    request.log.info(
      {
        jobId,
        sourceEventId: parsed.eventId,
        workspaceId: parsed.workspaceId,
      },
      'accepted incident review request',
    );
    await reply.status(200).send({ ok: true, jobId });
  } catch (error) {
    // A non-2xx response deliberately asks Slack to retry. No processed-event
    // marker is written at ingress, avoiding the classic mark-before-enqueue loss.
    request.log.error(
      { err: error },
      'failed to enqueue incident review request',
    );
    await reply.status(503).send({ error: 'queue_unavailable' });
  }
}

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
