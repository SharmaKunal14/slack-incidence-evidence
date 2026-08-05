import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { SlackOnboardingError } from '../../src/application/onboarding/slack-onboarding-service.js';
import {
  createSlackOnboardingCallbackHandler,
  type SlackOnboardingCallbackHandler,
} from '../../src/lambda/slack-onboarding-callback-handler.js';
import {
  createSlackOnboardingStartHandler,
  SLACK_ONBOARDING_BROWSER_COOKIE,
} from '../../src/lambda/slack-onboarding-start-handler.js';

const subject = '9f218e92-36a8-455d-869c-a76e27b399df';
const binding = 'b'.repeat(43);
const logger = pino({ level: 'silent' });

describe('Slack onboarding HTTP handlers', () => {
  it('starts only for a Cognito access token and returns an HttpOnly binding cookie', async () => {
    const start = vi.fn().mockResolvedValue({
      authorizationUrl: 'https://slack.com/oauth/v2/authorize?state=safe',
      browserBinding: binding,
      expiresAt: new Date('2026-08-05T01:10:00.000Z'),
    });
    const handler = createSlackOnboardingStartHandler({
      onboarding: { start },
      logger,
    });

    const response = structured(await handler(startEvent()));

    expect(response.statusCode).toBe(200);
    expect(response.cookies).toEqual([
      expect.stringContaining(`${SLACK_ONBOARDING_BROWSER_COOKIE}=${binding}`),
    ]);
    expect(response.cookies?.[0]).toContain('Secure; HttpOnly; SameSite=Lax');
    expect(response.body).not.toContain(binding);
    expect(start).toHaveBeenCalledWith(subject);
  });

  it('rejects a token type that API Gateway alone does not distinguish', async () => {
    const start = vi.fn();
    const handler = createSlackOnboardingStartHandler({
      onboarding: { start },
      logger,
    });

    const response = structured(await handler(startEvent({ tokenUse: 'id' })));

    expect(response.statusCode).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });

  it('completes from state plus browser binding and redirects to a fixed URL', async () => {
    const complete = vi.fn().mockResolvedValue({});
    const handler = callbackHandler(complete);

    const response = structured(
      await handler(callbackEvent({ state: 's'.repeat(43), code: 'code' })),
    );

    expect(complete).toHaveBeenCalledWith({
      state: 's'.repeat(43),
      browserBinding: binding,
      code: 'code',
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers?.['location']).toBe(
      'https://app.example.test/?slack=connected',
    );
    expect(response.cookies?.[0]).toContain('Max-Age=0');
  });

  it('does not call Slack without the binding cookie or after Slack denial', async () => {
    const complete = vi.fn();
    const handler = callbackHandler(complete);

    const missingCookie = structured(
      await handler(
        callbackEvent({ state: 's'.repeat(43), code: 'code' }, false),
      ),
    );
    const denied = structured(
      await handler(
        callbackEvent({ state: 's'.repeat(43), error: 'access_denied' }),
      ),
    );

    expect(missingCookie.headers?.['location']).toBe(
      'https://app.example.test/?slack=failed',
    );
    expect(denied.headers?.['location']).toBe(
      'https://app.example.test/?slack=failed',
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it('returns only a safe redirect when completion fails', async () => {
    const handler = callbackHandler(
      vi
        .fn()
        .mockRejectedValue(
          new SlackOnboardingError('OAUTH_STATE_INVALID', false),
        ),
    );

    const response = structured(
      await handler(
        callbackEvent({ state: 's'.repeat(43), code: 'secret-code' }),
      ),
    );

    expect(response.headers?.['location']).toBe(
      'https://app.example.test/?slack=failed',
    );
    expect(JSON.stringify(response)).not.toContain('secret-code');
  });
});

function callbackHandler(
  complete: ReturnType<typeof vi.fn>,
): SlackOnboardingCallbackHandler {
  return createSlackOnboardingCallbackHandler({
    onboarding: { complete },
    logger,
    successRedirectUrl: 'https://app.example.test/?slack=connected',
    failureRedirectUrl: 'https://app.example.test/?slack=failed',
  });
}

function startEvent(
  overrides: { readonly tokenUse?: string } = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    ...baseEvent('POST /onboarding/slack/start', 'POST'),
    requestContext: {
      ...baseEvent('POST /onboarding/slack/start', 'POST').requestContext,
      authorizer: {
        principalId: subject,
        integrationLatency: 0,
        jwt: {
          claims: { sub: subject, token_use: overrides.tokenUse ?? 'access' },
          scopes: [],
        },
      },
    },
  };
}

function callbackEvent(
  query: Record<string, string>,
  includeCookie = true,
): APIGatewayProxyEventV2 {
  const event: APIGatewayProxyEventV2 = {
    ...baseEvent('GET /onboarding/slack/callback', 'GET'),
    queryStringParameters: query,
  };
  if (includeCookie) {
    event.cookies = [`${SLACK_ONBOARDING_BROWSER_COOKIE}=${binding}`];
  }
  return event;
}

function baseEvent(routeKey: string, method: string): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey,
    rawPath: routeKey.slice(routeKey.indexOf(' ') + 1),
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api.example.test',
      domainPrefix: 'api',
      http: {
        method,
        path: routeKey.slice(routeKey.indexOf(' ') + 1),
        protocol: 'HTTP/1.1',
        sourceIp: '203.0.113.1',
        userAgent: 'test',
      },
      requestId: 'request-id',
      routeKey,
      stage: '$default',
      time: '05/Aug/2026:01:00:00 +0000',
      timeEpoch: 1_775_523_600_000,
    },
    isBase64Encoded: false,
  };
}

function structured(value: unknown): APIGatewayProxyStructuredResultV2 {
  return value as APIGatewayProxyStructuredResultV2;
}
