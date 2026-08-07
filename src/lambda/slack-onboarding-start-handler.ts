import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { Logger } from 'pino';
import { z } from 'zod';
import { SlackOnboardingError } from '../application/onboarding/slack-onboarding-service.js';
import type { SlackOnboardingStartService } from '../application/onboarding/slack-onboarding-service.js';

export const SLACK_ONBOARDING_BROWSER_COOKIE =
  '__Host-onrecord-slack-onboarding';
const subjectSchema = z.uuid();

export interface SlackOnboardingStartHandlerDependencies {
  readonly onboarding: Pick<SlackOnboardingStartService, 'start'>;
  readonly logger: Logger;
}

export type SlackOnboardingStartHandler = (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => Promise<APIGatewayProxyResultV2>;

export function createSlackOnboardingStartHandler(
  dependencies: SlackOnboardingStartHandlerDependencies,
): SlackOnboardingStartHandler {
  return async (event) => {
    if (event.routeKey !== 'POST /onboarding/slack/start') {
      return jsonResponse(404, { error: 'not_found' });
    }
    const claims = event.requestContext.authorizer.jwt.claims;
    const subject = subjectSchema.safeParse(claims['sub']);
    if (claims['token_use'] !== 'access' || !subject.success) {
      return jsonResponse(401, { error: 'unauthorized' });
    }

    try {
      const started = await dependencies.onboarding.start(subject.data);
      return {
        ...jsonResponse(200, {
          authorizationUrl: started.authorizationUrl,
          expiresAt: started.expiresAt.toISOString(),
        }),
        cookies: [
          `${SLACK_ONBOARDING_BROWSER_COOKIE}=${started.browserBinding}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax`,
        ],
      };
    } catch (error) {
      if (
        error instanceof SlackOnboardingError &&
        error.code === 'SLACK_INSTALLATION_ADMIN_REQUIRED'
      ) {
        dependencies.logger.warn(
          {
            requestId: event.requestContext.requestId,
            routeKey: event.routeKey,
            onboardingCode: error.code,
          },
          'Slack onboarding start request denied',
        );
        return jsonResponse(403, { error: 'admin_required' });
      }
      dependencies.logger.error(
        {
          requestId: event.requestContext.requestId,
          routeKey: event.routeKey,
        },
        'Slack onboarding start request failed',
      );
      return jsonResponse(500, { error: 'onboarding_start_failed' });
    }
  };
}

function jsonResponse(
  statusCode: number,
  body: unknown,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
    body: JSON.stringify(body),
  };
}
