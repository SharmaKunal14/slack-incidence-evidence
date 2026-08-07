import { z } from 'zod';
import type { Configuration } from './contracts.js';
import { ApiError, AuthenticationExpiredError } from './auth.js';

const startResponseSchema = z
  .object({
    authorizationUrl: z.url().max(2_048),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export type SlackOnboardingCallbackResult = 'connected' | 'failed';

export function consumeSlackOnboardingCallbackResult(): SlackOnboardingCallbackResult | null {
  const parameters = new URLSearchParams(location.search);
  const value = parameters.get('slack');
  if (value !== 'connected' && value !== 'failed') {
    return null;
  }
  history.replaceState({}, '', `${location.pathname}#/settings/integrations`);
  return value;
}

export async function requestSlackAuthorization(
  configuration: Configuration,
  token: string,
): Promise<string> {
  const response = await fetch(
    new URL('/onboarding/slack/start', configuration.apiBaseUrl),
    {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    },
  );
  if (response.status === 401) {
    sessionStorage.removeItem('review_access_token');
    window.dispatchEvent(new Event('incident-review:authentication-expired'));
    throw new AuthenticationExpiredError();
  }
  if (!response.ok) {
    throw new ApiError(response.status);
  }
  const text = await response.text();
  if (text.length > 10_000) {
    throw new Error('Slack onboarding response exceeded the browser limit');
  }
  const body = startResponseSchema.parse(JSON.parse(text) as unknown);
  const authorizationUrl = new URL(body.authorizationUrl);
  if (
    authorizationUrl.protocol !== 'https:' ||
    authorizationUrl.hostname !== 'slack.com' ||
    authorizationUrl.port !== '' ||
    authorizationUrl.username !== '' ||
    authorizationUrl.password !== '' ||
    authorizationUrl.pathname !== '/oauth/v2/authorize'
  ) {
    throw new Error('Slack authorization URL is not trusted');
  }
  if (Date.parse(body.expiresAt) <= Date.now()) {
    throw new Error('Slack authorization has already expired');
  }
  return authorizationUrl.toString();
}
