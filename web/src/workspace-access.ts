import { z } from 'zod';
import { ApiError, AuthenticationExpiredError } from './auth.js';
import type { Configuration } from './contracts.js';

const startSchema = z
  .object({
    authorizationUrl: z.url().max(2_048),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export type SlackIdentityCallbackResult = 'connected' | 'failed';

export function consumeSlackIdentityCallbackResult(): SlackIdentityCallbackResult | null {
  const parameters = new URLSearchParams(location.search);
  const value = parameters.get('slack_identity');
  if (value !== 'connected' && value !== 'failed') return null;
  history.replaceState({}, '', `${location.pathname}#/settings/integrations`);
  return value;
}

export async function requestSlackIdentityAuthorization(
  configuration: Configuration,
  token: string,
  invitationToken: string,
): Promise<string> {
  const response = await fetch(
    new URL('/review/invitations/slack/start', configuration.apiBaseUrl),
    {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ invitationToken }),
    },
  );
  if (response.status === 401) {
    sessionStorage.removeItem('review_access_token');
    window.dispatchEvent(new Event('incident-review:authentication-expired'));
    throw new AuthenticationExpiredError();
  }
  if (!response.ok) throw new ApiError(response.status);
  const text = await response.text();
  if (text.length > 10_000)
    throw new Error('Slack identity response exceeded the browser limit');
  const body = startSchema.parse(JSON.parse(text) as unknown);
  const url = new URL(body.authorizationUrl);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'slack.com' ||
    url.pathname !== '/openid/connect/authorize'
  ) {
    throw new Error('Slack identity URL is not trusted');
  }
  if (Date.parse(body.expiresAt) <= Date.now())
    throw new Error('Slack identity request has expired');
  return url.toString();
}
