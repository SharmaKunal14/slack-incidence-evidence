import { createHmac } from 'node:crypto';
import { Writable } from 'node:stream';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import pino, { type Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type {
  RequestIncidentReview,
  RequestIncidentReviewCommand,
} from '../../src/application/request-incident-review.js';
import {
  createSlackIngressHandler,
  type SlackIngressDependencies,
} from '../../src/lambda/slack-ingress-handler.js';
import { SlackSignatureVerifier } from '../../src/integrations/slack/signature-verifier.js';

const secret = 'test-signing-secret';
const now = new Date('2026-07-17T01:00:00.000Z');
const timestamp = String(now.getTime() / 1000);

function sign(rawBody: string): string {
  return `v0=${createHmac('sha256', secret)
    .update(`v0:${timestamp}:${rawBody}`, 'utf8')
    .digest('hex')}`;
}

function eventFor(
  rawBody: string,
  options: {
    readonly base64?: boolean;
    readonly headers?: APIGatewayProxyEventV2['headers'];
  } = {},
): APIGatewayProxyEventV2 {
  const base64 = options.base64 ?? false;
  return {
    version: '2.0',
    routeKey: 'POST /integrations/slack/events',
    rawPath: '/integrations/slack/events',
    rawQueryString: '',
    headers: options.headers ?? {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': sign(rawBody),
    },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'example.execute-api.ap-southeast-2.amazonaws.com',
      domainPrefix: 'example',
      http: {
        method: 'POST',
        path: '/integrations/slack/events',
        protocol: 'HTTP/1.1',
        sourceIp: '203.0.113.1',
        userAgent: 'Slackbot 1.0',
      },
      requestId: 'request-id',
      routeKey: 'POST /integrations/slack/events',
      stage: '$default',
      time: '17/Jul/2026:01:00:00 +0000',
      timeEpoch: now.getTime(),
    },
    body: base64 ? Buffer.from(rawBody, 'utf8').toString('base64') : rawBody,
    isBase64Encoded: base64,
  };
}

function incidentMention(title = 'Checkout outage'): string {
  return JSON.stringify({
    type: 'event_callback',
    event_id: 'Ev001',
    team_id: 'T001',
    event: {
      type: 'app_mention',
      user: 'U001',
      text: `<@A001> create rca: ${title}`,
      ts: '1721178000.000100',
      channel: 'C001',
    },
  });
}

type Execute = RequestIncidentReview['execute'];

function dependencies(
  execute: Execute,
  logger: Logger = pino({ level: 'silent' }),
): SlackIngressDependencies {
  return {
    clock: { now: () => now },
    logger,
    signatureVerifier: new SlackSignatureVerifier(secret),
    requestIncidentReview: { execute },
  };
}

function structured(
  response: APIGatewayProxyResultV2,
): APIGatewayProxyStructuredResultV2 {
  if (typeof response === 'string') {
    throw new Error('expected a structured API Gateway response');
  }
  return response;
}

function parsedBody(response: APIGatewayProxyResultV2): unknown {
  const body = structured(response).body;
  return JSON.parse(body ?? '') as unknown;
}

describe('API Gateway Slack ingress Lambda', () => {
  it('verifies the exact raw body and enqueues before acknowledging Slack', async () => {
    const body = incidentMention();
    let enqueueCompleted = false;
    const execute = vi.fn<Execute>().mockImplementation(async () => {
      await Promise.resolve();
      enqueueCompleted = true;
      return 'job-1';
    });
    const handler = createSlackIngressHandler(dependencies(execute));

    const response = await handler(eventFor(body));

    expect(enqueueCompleted).toBe(true);
    expect(structured(response).statusCode).toBe(200);
    expect(parsedBody(response)).toEqual({ ok: true, jobId: 'job-1' });
    expect(execute).toHaveBeenCalledWith({
      eventId: 'Ev001',
      workspaceId: 'T001',
      channelId: 'C001',
      messageTs: '1721178000.000100',
      userId: 'U001',
      requestedTitle: 'Checkout outage',
    } satisfies RequestIncidentReviewCommand);
  });

  it('decodes a base64 API Gateway body before signature verification', async () => {
    const body = incidentMention('Unicode checkout outage 🚨');
    const execute = vi.fn<Execute>().mockResolvedValue('job-base64');
    const handler = createSlackIngressHandler(dependencies(execute));
    const event = eventFor(body, {
      base64: true,
      // API Gateway normally lower-cases headers, but the adapter remains
      // correct for test events and upstreams that preserve casing.
      headers: {
        'X-Slack-Request-Timestamp': timestamp,
        'X-SLACK-SIGNATURE': sign(body),
      },
    });

    const response = await handler(event);

    expect(structured(response).statusCode).toBe(200);
    expect(parsedBody(response)).toEqual({
      ok: true,
      jobId: 'job-base64',
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('returns a signed Slack URL verification challenge without enqueueing', async () => {
    const body = JSON.stringify({
      type: 'url_verification',
      challenge: 'challenge-token',
    });
    const execute = vi.fn<Execute>();
    const handler = createSlackIngressHandler(dependencies(execute));

    const response = await handler(eventFor(body));

    expect(structured(response).statusCode).toBe(200);
    expect(parsedBody(response)).toEqual({ challenge: 'challenge-token' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature without parsing or enqueueing the request', async () => {
    const body = incidentMention();
    const execute = vi.fn<Execute>();
    const handler = createSlackIngressHandler(dependencies(execute));
    const event = eventFor(body, {
      headers: {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': sign('{"different":true}'),
      },
    });

    const response = await handler(event);

    expect(structured(response).statusCode).toBe(401);
    expect(parsedBody(response)).toEqual({
      error: 'invalid_slack_signature',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns 400 for signed malformed JSON', async () => {
    const body = '{"type":"event_callback"';
    const execute = vi.fn<Execute>();
    const handler = createSlackIngressHandler(dependencies(execute));

    const response = await handler(eventFor(body));

    expect(structured(response).statusCode).toBe(400);
    expect(parsedBody(response)).toEqual({ error: 'invalid_json' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns 400 for a signed JSON value outside the Slack envelope contract', async () => {
    const body = JSON.stringify({ type: 'unexpected', content: 'private' });
    const execute = vi.fn<Execute>();
    const handler = createSlackIngressHandler(dependencies(execute));

    const response = await handler(eventFor(body));

    expect(structured(response).statusCode).toBe(400);
    expect(parsedBody(response)).toEqual({ error: 'invalid_slack_payload' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns 503 on queue failure and never logs request or error content', async () => {
    const sensitiveTitle = 'customer-secret-checkout-outage';
    const sensitiveError = 'publisher echoed customer-secret-message';
    const body = incidentMention(sensitiveTitle);
    let logOutput = '';
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        logOutput += chunk.toString('utf8');
        callback();
      },
    });
    const logger = pino({ level: 'debug' }, destination);
    const execute = vi
      .fn<Execute>()
      .mockRejectedValue(new Error(sensitiveError));
    const handler = createSlackIngressHandler(dependencies(execute, logger));

    const response = await handler(eventFor(body));

    expect(structured(response).statusCode).toBe(503);
    expect(parsedBody(response)).toEqual({ error: 'queue_unavailable' });
    expect(execute).toHaveBeenCalledOnce();
    expect(logOutput).toContain('failed to enqueue incident review request');
    expect(logOutput).not.toContain(sensitiveTitle);
    expect(logOutput).not.toContain(sensitiveError);
    expect(logOutput).not.toContain(body);
  });
});
