import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { SlackInstallationDisconnectionError } from '../../src/application/onboarding/disconnect-slack-installation.js';
import { createSlackInstallationDisconnectHandler } from '../../src/lambda/slack-installation-disconnect-handler.js';

const subject = '9f218e92-36a8-455d-869c-a76e27b399df';
const logger = pino({ level: 'silent' });

describe('Slack installation disconnect HTTP handler', () => {
  it('passes only validated JWT authority and workspace input to the service', async () => {
    const execute = vi.fn().mockResolvedValue({
      workspaceId: 'T001',
      status: 'DISCONNECTED',
      idempotent: false,
    });
    const handler = createSlackInstallationDisconnectHandler({
      disconnect: { execute },
      logger,
    });

    const response = structured(await handler(event()));

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith({
      workspaceId: 'T001',
      cognitoSubject: subject,
      requestId: 'request-id',
    });
    expect(response.body).not.toContain('secret');
    expect(response.body).not.toContain('token');
  });

  it('rejects ID tokens and mismatched confirmation before side effects', async () => {
    const execute = vi.fn();
    const handler = createSlackInstallationDisconnectHandler({
      disconnect: { execute },
      logger,
    });

    expect(
      structured(await handler(event({ tokenUse: 'id' }))).statusCode,
    ).toBe(401);
    expect(
      structured(
        await handler(
          event({ body: JSON.stringify({ confirmation: 'T999' }) }),
        ),
      ).statusCode,
    ).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns forbidden for a non-admin without exposing internal codes', async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(
        new SlackInstallationDisconnectionError(
          'SLACK_INSTALLATION_ADMIN_REQUIRED',
          false,
        ),
      );
    const handler = createSlackInstallationDisconnectHandler({
      disconnect: { execute },
      logger,
    });

    const response = structured(await handler(event()));

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body ?? '')).toEqual({
      error: 'admin_required',
    });
  });

  it('returns a retryable, no-store response for partial external failure', async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(
        new SlackInstallationDisconnectionError(
          'SLACK_APP_UNINSTALL_FAILED',
          true,
        ),
      );
    const handler = createSlackInstallationDisconnectHandler({
      disconnect: { execute },
      logger,
    });

    const response = structured(await handler(event()));

    expect(response.statusCode).toBe(503);
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'retry-after': '5',
    });
  });
});

function event(
  overrides: { readonly tokenUse?: string; readonly body?: string } = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    version: '2.0',
    routeKey: 'POST /onboarding/slack/{workspaceId}/disconnect',
    rawPath: '/onboarding/slack/T001/disconnect',
    rawQueryString: '',
    headers: {},
    pathParameters: { workspaceId: 'T001' },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: {
        integrationLatency: 0,
        jwt: {
          claims: { sub: subject, token_use: overrides.tokenUse ?? 'access' },
          scopes: [],
        },
        principalId: subject,
      },
      domainName: 'api.example.test',
      domainPrefix: 'api',
      http: {
        method: 'POST',
        path: '/onboarding/slack/T001/disconnect',
        protocol: 'HTTP/1.1',
        sourceIp: '203.0.113.1',
        userAgent: 'test',
      },
      requestId: 'request-id',
      routeKey: 'POST /onboarding/slack/{workspaceId}/disconnect',
      stage: '$default',
      time: '07/Aug/2026:01:00:00 +0000',
      timeEpoch: 1_785_978_000_000,
    },
    body: overrides.body ?? JSON.stringify({ confirmation: 'T001' }),
    isBase64Encoded: false,
  };
}

function structured(value: unknown): APIGatewayProxyStructuredResultV2 {
  return value as APIGatewayProxyStructuredResultV2;
}
