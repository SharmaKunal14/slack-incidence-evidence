import { z } from 'zod';
import { configurationSchema, type Configuration } from './contracts.js';

declare global {
  interface Window {
    __INCIDENT_REVIEW_CONFIG__?: unknown;
  }
}

export class ApiError extends Error {
  public constructor(public readonly status: number) {
    super('Review API request failed');
    this.name = 'ApiError';
  }
}

export class AuthenticationExpiredError extends Error {
  public constructor() {
    super('Review session expired');
    this.name = 'AuthenticationExpiredError';
  }
}

export function loadConfiguration(): Configuration {
  return configurationSchema.parse(window.__INCIDENT_REVIEW_CONFIG__);
}

export async function apiRequest(
  configuration: Configuration,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(new URL(path, configuration.apiBaseUrl), {
    ...init,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
  });
  if (response.status === 401) {
    sessionStorage.removeItem('review_access_token');
    window.dispatchEvent(new Event('incident-review:authentication-expired'));
    throw new AuthenticationExpiredError();
  }
  if (!response.ok) {
    throw new ApiError(response.status);
  }
  const body = await response.text();
  if (body.length > 5_000_000) {
    throw new Error('API response exceeded the browser limit');
  }
  return JSON.parse(body) as unknown;
}

export async function startAuthorization(
  configuration: Configuration,
): Promise<void> {
  const verifier = randomValue(64);
  const state = randomValue(32);
  const challenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ),
  );
  sessionStorage.setItem('oauth_verifier', verifier);
  sessionStorage.setItem('oauth_state', state);
  sessionStorage.setItem('post_login_hash', location.hash || '#/');
  const authorize = new URL('/oauth2/authorize', configuration.cognitoBaseUrl);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: configuration.cognitoClientId,
    redirect_uri: configuration.redirectUri,
    scope: 'openid',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  location.assign(authorize);
}

export async function completeAuthorizationCallback(
  configuration: Configuration,
): Promise<void> {
  const parameters = new URLSearchParams(location.search);
  const code = parameters.get('code');
  if (code === null) {
    return;
  }
  const state = parameters.get('state');
  const expectedState = sessionStorage.getItem('oauth_state');
  const verifier = sessionStorage.getItem('oauth_verifier');
  if (
    state === null ||
    expectedState === null ||
    verifier === null ||
    state !== expectedState
  ) {
    throw new Error('OAuth callback state validation failed');
  }
  const tokenUrl = new URL('/oauth2/token', configuration.cognitoBaseUrl);
  const response = await fetch(tokenUrl, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: configuration.cognitoClientId,
      code,
      redirect_uri: configuration.redirectUri,
      code_verifier: verifier,
    }),
  });
  const tokenBody = await response.text();
  if (!response.ok || tokenBody.length > 100_000) {
    throw new Error('OAuth token exchange failed');
  }
  const token = z
    .object({
      access_token: z.string().min(1).max(16_384),
      token_type: z.literal('Bearer'),
      expires_in: z.number().int().positive(),
    })
    .passthrough()
    .parse(JSON.parse(tokenBody) as unknown);
  sessionStorage.setItem('review_access_token', token.access_token);
  const postLoginHash = sessionStorage.getItem('post_login_hash') ?? '#/';
  sessionStorage.removeItem('oauth_state');
  sessionStorage.removeItem('oauth_verifier');
  sessionStorage.removeItem('post_login_hash');
  history.replaceState({}, '', `${location.pathname}${postLoginHash}`);
}

export function signOut(configuration: Configuration): void {
  sessionStorage.clear();
  const logout = new URL('/logout', configuration.cognitoBaseUrl);
  logout.search = new URLSearchParams({
    client_id: configuration.cognitoClientId,
    logout_uri: configuration.redirectUri,
  }).toString();
  location.assign(logout);
}

function randomValue(byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function base64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}
