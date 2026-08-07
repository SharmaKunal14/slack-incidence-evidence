import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import type { Logger } from 'pino';
import { z } from 'zod';
import { cognitoSubjectSchema } from '../application/identity/cognito-subject.js';
import {
  SlackInstallationDisconnectionError,
  type DisconnectSlackInstallation,
} from '../application/onboarding/disconnect-slack-installation.js';

const workspaceIdSchema = z.string().regex(/^T[A-Z0-9]{1,63}$/u);
const bodySchema = z.object({ confirmation: workspaceIdSchema }).strict();
const MAX_BODY_BYTES = 1_024;

export type SlackInstallationDisconnectHandler = (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => Promise<APIGatewayProxyResultV2>;

export function createSlackInstallationDisconnectHandler(dependencies: {
  readonly disconnect: Pick<DisconnectSlackInstallation, 'execute'>;
  readonly logger: Logger;
}): SlackInstallationDisconnectHandler {
  return async (event) => {
    const subject = authenticatedSubject(event);
    if (subject === null) {
      return jsonResponse(401, { error: 'unauthorized' });
    }
    try {
      const workspaceId = workspaceIdSchema.parse(
        event.pathParameters?.['workspaceId'],
      );
      const body = bodySchema.parse(parseJsonBody(event));
      if (body.confirmation !== workspaceId) {
        return jsonResponse(400, { error: 'invalid_request' });
      }
      const result = await dependencies.disconnect.execute({
        workspaceId,
        cognitoSubject: subject,
        requestId: event.requestContext.requestId,
      });
      return jsonResponse(200, result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return jsonResponse(400, { error: 'invalid_request' });
      }
      if (error instanceof SlackInstallationDisconnectionError) {
        dependencies.logger.warn(
          {
            requestId: event.requestContext.requestId,
            routeKey: event.routeKey,
            disconnectionCode: error.code,
            retryable: error.retryable,
          },
          'Slack installation disconnection failed',
        );
        if (error.code === 'SLACK_INSTALLATION_ADMIN_REQUIRED') {
          return jsonResponse(403, { error: 'admin_required' });
        }
        if (error.code === 'SLACK_INSTALLATION_DISCONNECT_CONFLICT') {
          return jsonResponse(409, { error: 'disconnect_conflict' });
        }
        if (error.retryable) {
          return jsonResponse(
            503,
            { error: 'disconnect_temporarily_unavailable' },
            { 'retry-after': '5' },
          );
        }
      }
      dependencies.logger.error(
        {
          requestId: event.requestContext.requestId,
          routeKey: event.routeKey,
        },
        'Slack installation disconnect request failed',
      );
      return jsonResponse(500, { error: 'internal_server_error' });
    }
  };
}

function authenticatedSubject(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): string | null {
  const claims = event.requestContext.authorizer.jwt.claims;
  if (claims['token_use'] !== 'access') {
    return null;
  }
  const subject = cognitoSubjectSchema.safeParse(claims['sub']);
  return subject.success ? subject.data : null;
}

function parseJsonBody(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): unknown {
  const body = Buffer.from(
    event.body ?? '',
    event.isBase64Encoded ? 'base64' : 'utf8',
  );
  if (body.byteLength === 0 || body.byteLength > MAX_BODY_BYTES) {
    return undefined;
  }
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function jsonResponse(
  statusCode: number,
  body: unknown,
  additionalHeaders: Readonly<Record<string, string>> = {},
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...additionalHeaders,
    },
    body: JSON.stringify(body),
  };
}
