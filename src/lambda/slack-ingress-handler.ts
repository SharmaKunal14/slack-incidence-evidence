import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import type { Logger } from 'pino';
import type { Clock } from '../application/ports/clock.js';
import type {
  RequestIncidentReview,
  RequestIncidentReviewCommand,
} from '../application/request-incident-review.js';
import {
  InvalidSlackPayloadError,
  parseSlackRequest,
} from '../integrations/slack/event-parser.js';
import type { SlackSignatureVerifier } from '../integrations/slack/signature-verifier.js';

export interface SlackIngressDependencies {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly signatureVerifier: SlackSignatureVerifier;
  readonly requestIncidentReview: Pick<RequestIncidentReview, 'execute'>;
}

export type SlackIngressHandler = (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyResultV2>;

/**
 * Creates the API Gateway HTTP API adapter for Slack's Events API.
 *
 * The adapter intentionally performs only delivery-boundary work. Dependency
 * construction, AWS clients, queue configuration, and business rules belong in
 * the Lambda composition root and application layer respectively.
 */
export function createSlackIngressHandler(
  dependencies: SlackIngressDependencies,
): SlackIngressHandler {
  return async (event) => {
    // API Gateway represents request bodies as strings and marks binary bodies
    // as base64. Slack signs the original bytes, so verification must happen
    // before JSON parsing or any other transformation.
    const rawBody = reconstructRawBody(event);
    const verification = dependencies.signatureVerifier.verify({
      rawBody,
      timestamp: findHeader(event.headers, 'x-slack-request-timestamp'),
      signature: findHeader(event.headers, 'x-slack-signature'),
      now: dependencies.clock.now(),
    });

    if (!verification.valid) {
      dependencies.logger.warn(
        { verificationFailure: verification.reason },
        'rejected unauthenticated Slack request',
      );
      return jsonResponse(401, { error: 'invalid_slack_signature' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }

    let parsed;
    try {
      parsed = parseSlackRequest(payload);
    } catch (error) {
      if (error instanceof InvalidSlackPayloadError) {
        return jsonResponse(400, { error: 'invalid_slack_payload' });
      }

      // Keep untrusted request content and exception messages out of logs. A
      // stable event is enough to alert on this unexpected parser failure.
      dependencies.logger.error('unexpected Slack payload parser failure');
      return jsonResponse(500, { error: 'internal_server_error' });
    }

    if (parsed.kind === 'url_verification') {
      return jsonResponse(200, { challenge: parsed.challenge });
    }

    if (parsed.kind === 'ignored') {
      dependencies.logger.debug(
        { eventType: parsed.eventType },
        'ignored Slack event',
      );
      return jsonResponse(200, { ok: true });
    }

    try {
      // Awaiting the application use case guarantees that its durable queue
      // publish completes before Slack receives an acknowledgement.
      const command: RequestIncidentReviewCommand = {
        eventId: parsed.eventId,
        workspaceId: parsed.workspaceId,
        channelId: parsed.channelId,
        messageTs: parsed.messageTs,
        ...(parsed.threadTs === undefined ? {} : { threadTs: parsed.threadTs }),
        userId: parsed.userId,
        requestedTitle: parsed.requestedTitle,
      };
      const jobId = await dependencies.requestIncidentReview.execute(command);
      dependencies.logger.info(
        {
          jobId,
          sourceEventId: parsed.eventId,
          workspaceId: parsed.workspaceId,
        },
        'accepted incident review request',
      );
      return jsonResponse(200, { ok: true, jobId });
    } catch {
      // A non-2xx response deliberately asks Slack to retry. Do not include the
      // thrown value: SDK errors can echo request or customer content.
      dependencies.logger.error('failed to enqueue incident review request');
      return jsonResponse(503, { error: 'queue_unavailable' });
    }
  };
}

function reconstructRawBody(event: APIGatewayProxyEventV2): Buffer {
  return Buffer.from(
    event.body ?? '',
    event.isBase64Encoded === true ? 'base64' : 'utf8',
  );
}

function findHeader(
  headers: APIGatewayProxyEventV2['headers'],
  expectedName: string,
): string | undefined {
  const normalizedExpectedName = expectedName.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === normalizedExpectedName) {
      return value;
    }
  }
  return undefined;
}

function jsonResponse(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}
