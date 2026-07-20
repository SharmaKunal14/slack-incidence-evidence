import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import type { Logger } from 'pino';
import type { Clock } from '../application/ports/clock.js';
import type { IncidentScopeModal } from '../application/ports/incident-scope-modal.js';
import type {
  RequestIncidentReview,
  RequestIncidentReviewCommand,
  RequestScopedIncidentReview,
} from '../application/request-incident-review.js';
import {
  InvalidSlackPayloadError,
  parseSlackRequest,
} from '../integrations/slack/event-parser.js';
import type { SlackSignatureVerifier } from '../integrations/slack/signature-verifier.js';
import {
  InvalidSlackInteractionError,
  parseSlackInteraction,
} from '../integrations/slack/interaction-parser.js';

export interface SlackIngressDependencies {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly signatureVerifier: SlackSignatureVerifier;
  readonly requestIncidentReview: Pick<RequestIncidentReview, 'execute'>;
  readonly requestScopedIncidentReview?: Pick<
    RequestScopedIncidentReview,
    'execute'
  >;
  readonly incidentScopeModal?: IncidentScopeModal;
  readonly evidenceRetentionDays?: number;
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
    if (rawBody.byteLength > 1_048_576) {
      return jsonResponse(413, { error: 'request_too_large' });
    }
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
      payload = parseRequestPayload(event, rawBody);
    } catch {
      return jsonResponse(400, {
        error: isFormRequest(event) ? 'invalid_request_body' : 'invalid_json',
      });
    }

    if (isFormRequest(event)) {
      return handleInteraction(payload, dependencies);
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

async function handleInteraction(
  payload: unknown,
  dependencies: SlackIngressDependencies,
): Promise<APIGatewayProxyResultV2> {
  let parsed;
  try {
    parsed = parseSlackInteraction(payload, dependencies.clock.now());
  } catch (error) {
    if (
      error instanceof InvalidSlackInteractionError &&
      error.fieldErrors.length > 0
    ) {
      return jsonResponse(200, {
        response_action: 'errors',
        errors: Object.fromEntries(
          error.fieldErrors.map(({ blockId, message }) => [blockId, message]),
        ),
      });
    }
    return jsonResponse(400, { error: 'invalid_slack_interaction' });
  }

  if (parsed.kind === 'ignored') {
    dependencies.logger.debug(
      { interactionType: parsed.interactionType },
      'ignored Slack interaction',
    );
    return jsonResponse(200, { ok: true });
  }

  if (parsed.kind === 'open_incident_scope') {
    if (dependencies.incidentScopeModal === undefined) {
      dependencies.logger.error('Slack incident scope modal is not configured');
      return jsonResponse(503, { error: 'modal_unavailable' });
    }
    const endedAt = dependencies.clock.now();
    try {
      await dependencies.incidentScopeModal.open({
        triggerId: parsed.triggerId,
        workspaceId: parsed.workspaceId,
        userId: parsed.userId,
        channelId: parsed.channelId,
        messageTs: parsed.messageTs,
        ...(parsed.threadTs === undefined ? {} : { threadTs: parsed.threadTs }),
        defaultStartedAt: new Date(endedAt.getTime() - 60 * 60_000),
        defaultEndedAt: endedAt,
        evidenceRetentionDays: dependencies.evidenceRetentionDays ?? 30,
      });
      dependencies.logger.info(
        { workspaceId: parsed.workspaceId },
        'opened Slack incident scope modal',
      );
      return jsonResponse(200, { ok: true });
    } catch {
      dependencies.logger.error('failed to open Slack incident scope modal');
      return jsonResponse(503, { error: 'modal_unavailable' });
    }
  }

  if (dependencies.requestScopedIncidentReview === undefined) {
    dependencies.logger.error(
      'scoped incident queue publisher is not configured',
    );
    return jsonResponse(503, { error: 'queue_unavailable' });
  }
  try {
    const jobId = await dependencies.requestScopedIncidentReview.execute(
      parsed.command,
    );
    dependencies.logger.info(
      {
        jobId,
        sourceEventId: parsed.command.eventId,
        workspaceId: parsed.command.workspaceId,
        sourceCount: parsed.command.channels.length,
      },
      'accepted scoped incident review request',
    );
    return jsonResponse(200, {});
  } catch {
    dependencies.logger.error(
      'failed to enqueue scoped incident review request',
    );
    return jsonResponse(503, { error: 'queue_unavailable' });
  }
}

function reconstructRawBody(event: APIGatewayProxyEventV2): Buffer {
  return Buffer.from(
    event.body ?? '',
    event.isBase64Encoded === true ? 'base64' : 'utf8',
  );
}

function parseRequestPayload(
  event: APIGatewayProxyEventV2,
  rawBody: Buffer,
): unknown {
  const body = rawBody.toString('utf8');
  if (!isFormRequest(event)) {
    return JSON.parse(body) as unknown;
  }
  const encodedPayload = new URLSearchParams(body).get('payload');
  if (encodedPayload === null || encodedPayload.length > 1_000_000) {
    throw new Error('invalid Slack interaction body');
  }
  return JSON.parse(encodedPayload) as unknown;
}

function isFormRequest(event: APIGatewayProxyEventV2): boolean {
  return (
    findHeader(event.headers, 'content-type')
      ?.toLowerCase()
      .startsWith('application/x-www-form-urlencoded') ?? false
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
