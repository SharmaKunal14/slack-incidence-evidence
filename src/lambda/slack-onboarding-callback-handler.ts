import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { Logger } from 'pino';
import { SlackOnboardingError } from '../application/onboarding/slack-onboarding-service.js';
import type { SlackOnboardingService } from '../application/onboarding/slack-onboarding-service.js';
import { SLACK_ONBOARDING_BROWSER_COOKIE } from './slack-onboarding-start-handler.js';

export interface SlackOnboardingCallbackHandlerDependencies {
  readonly onboarding: Pick<SlackOnboardingService, 'complete'>;
  readonly logger: Logger;
  readonly successRedirectUrl: string;
  readonly failureRedirectUrl: string;
}

export type SlackOnboardingCallbackHandler = (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyResultV2>;

export function createSlackOnboardingCallbackHandler(
  dependencies: SlackOnboardingCallbackHandlerDependencies,
): SlackOnboardingCallbackHandler {
  const successRedirectUrl = requireStaticHttpsUrl(
    dependencies.successRedirectUrl,
  );
  const failureRedirectUrl = requireStaticHttpsUrl(
    dependencies.failureRedirectUrl,
  );

  return async (event) => {
    if (event.routeKey !== 'GET /onboarding/slack/callback') {
      return redirect(failureRedirectUrl);
    }
    const query = event.queryStringParameters;
    const browserBinding = readCookie(event, SLACK_ONBOARDING_BROWSER_COOKIE);
    const state = query?.['state'];
    const code = query?.['code'];
    if (
      query?.['error'] !== undefined ||
      browserBinding === undefined ||
      state === undefined ||
      code === undefined
    ) {
      return redirect(failureRedirectUrl);
    }

    try {
      await dependencies.onboarding.complete({ state, browserBinding, code });
      return redirect(successRedirectUrl);
    } catch (error) {
      dependencies.logger.warn(
        {
          requestId: event.requestContext.requestId,
          onboardingCode:
            error instanceof SlackOnboardingError ? error.code : 'UNEXPECTED',
          retryable:
            error instanceof SlackOnboardingError ? error.retryable : false,
        },
        'Slack onboarding callback failed',
      );
      return redirect(failureRedirectUrl);
    }
  };
}

function readCookie(
  event: APIGatewayProxyEventV2,
  name: string,
): string | undefined {
  const values =
    event.cookies ??
    Object.entries(event.headers)
      .filter(([header]) => header.toLowerCase() === 'cookie')
      .flatMap(([, value]) => (value === undefined ? [] : [value]));
  for (const header of values) {
    for (const pair of header.split(';')) {
      const separator = pair.indexOf('=');
      if (separator < 1 || pair.slice(0, separator).trim() !== name) {
        continue;
      }
      const value = pair.slice(separator + 1).trim();
      if (value.length >= 1 && value.length <= 128) {
        return value;
      }
    }
  }
  return undefined;
}

function redirect(location: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 303,
    headers: {
      'cache-control': 'no-store',
      location,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
    cookies: [
      `${SLACK_ONBOARDING_BROWSER_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
    ],
  };
}

function requireStaticHttpsUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Onboarding redirect must be a static HTTPS URL');
  }
  return url.toString();
}
