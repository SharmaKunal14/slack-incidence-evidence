import { z } from 'zod';
import type {
  SlackBotIdentity,
  SlackInstallerAuthority,
  SlackOAuthGrant,
  SlackOAuthProvider,
} from '../../application/ports/slack-oauth-provider.js';
import { SlackOAuthProviderRequestError } from '../../application/ports/slack-oauth-provider.js';
import { slackOAuthV2AccessResponseSchema } from './oauth-v2-contracts.js';

const OAUTH_ACCESS_URL = 'https://slack.com/api/oauth.v2.access';
const AUTH_TEST_URL = 'https://slack.com/api/auth.test';
const USERS_INFO_URL = 'https://slack.com/api/users.info';
const MAX_RESPONSE_BYTES = 256 * 1024;

const authTestResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      team_id: z.string().regex(/^T[A-Z0-9]{1,63}$/u),
      user_id: z.string().regex(/^[UW][A-Z0-9]{1,63}$/u),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().trim().min(1).max(128),
    })
    .passthrough(),
]);

const userInfoResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      user: z
        .object({
          id: z.string().regex(/^[UW][A-Z0-9]{1,63}$/u),
          is_admin: z.boolean().optional(),
          is_owner: z.boolean().optional(),
          is_primary_owner: z.boolean().optional(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().trim().min(1).max(128),
    })
    .passthrough(),
]);

const printableProviderValue = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[\x21-\x7e]+$/u);

export type SlackOAuthProviderErrorCode =
  | 'SLACK_OAUTH_NETWORK_ERROR'
  | 'SLACK_OAUTH_RATE_LIMITED'
  | 'SLACK_OAUTH_HTTP_ERROR'
  | 'SLACK_OAUTH_INVALID_RESPONSE'
  | 'SLACK_OAUTH_REQUEST_REJECTED'
  | 'SLACK_AUTH_TEST_NETWORK_ERROR'
  | 'SLACK_AUTH_TEST_RATE_LIMITED'
  | 'SLACK_AUTH_TEST_HTTP_ERROR'
  | 'SLACK_AUTH_TEST_INVALID_RESPONSE'
  | 'SLACK_AUTH_TEST_REJECTED'
  | 'SLACK_USERS_INFO_NETWORK_ERROR'
  | 'SLACK_USERS_INFO_RATE_LIMITED'
  | 'SLACK_USERS_INFO_HTTP_ERROR'
  | 'SLACK_USERS_INFO_INVALID_RESPONSE'
  | 'SLACK_USERS_INFO_REJECTED';

export class SlackOAuthProviderError extends SlackOAuthProviderRequestError {
  public constructor(
    readonly code: SlackOAuthProviderErrorCode,
    override readonly retryable: boolean,
  ) {
    super(retryable);
    this.name = 'SlackOAuthProviderError';
  }
}

/** Bounded Slack OAuth V2 and bot-identity HTTP adapter. */
export class WebApiSlackOAuthProvider implements SlackOAuthProvider {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly basicAuthorization: string;

  public constructor(
    configuration: {
      readonly clientId: string;
      readonly clientSecret: string;
    },
    options: {
      readonly request?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {
    const clientId = printableProviderValue
      .max(256)
      .parse(configuration.clientId);
    const clientSecret = printableProviderValue
      .max(256)
      .parse(configuration.clientSecret);
    if (clientId.includes(':')) {
      throw new Error('Slack OAuth client ID must not contain a colon');
    }
    this.basicAuthorization = `Basic ${Buffer.from(
      `${clientId}:${clientSecret}`,
      'utf8',
    ).toString('base64')}`;
    this.request = options.request ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('Slack OAuth timeout must be a positive integer');
    }
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly redirectUri: string;
  }): Promise<SlackOAuthGrant> {
    const code = printableProviderValue.parse(input.code);
    const redirectUri = parseHttpsUrl(input.redirectUri);
    const body = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    const response = await this.post(
      OAUTH_ACCESS_URL,
      {
        accept: 'application/json',
        authorization: this.basicAuthorization,
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body,
      'SLACK_OAUTH',
    );
    const parsed = slackOAuthV2AccessResponseSchema.safeParse(
      await parseBoundedJson(response, 'SLACK_OAUTH_INVALID_RESPONSE'),
    );
    if (!parsed.success) {
      throw new SlackOAuthProviderError('SLACK_OAUTH_INVALID_RESPONSE', false);
    }
    if (!parsed.data.ok) {
      throw new SlackOAuthProviderError(
        'SLACK_OAUTH_REQUEST_REJECTED',
        isRetryableSlackError(parsed.data.error),
      );
    }
    return {
      appId: parsed.data.app_id,
      teamId: parsed.data.team.id,
      teamName: parsed.data.team.name,
      enterpriseId: parsed.data.enterprise?.id ?? null,
      botUserId: parsed.data.bot_user_id,
      authedUserId: parsed.data.authed_user.id,
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? null,
      expiresInSeconds: parsed.data.expires_in ?? null,
      grantedScopes: parsed.data.scope
        .split(',')
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
      isEnterpriseInstall: parsed.data.is_enterprise_install ?? false,
    };
  }

  public async verifyBot(accessToken: string): Promise<SlackBotIdentity> {
    const token = printableProviderValue.parse(accessToken);
    const response = await this.post(
      AUTH_TEST_URL,
      {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      new URLSearchParams(),
      'SLACK_AUTH_TEST',
    );
    const parsed = authTestResponseSchema.safeParse(
      await parseBoundedJson(response, 'SLACK_AUTH_TEST_INVALID_RESPONSE'),
    );
    if (!parsed.success) {
      throw new SlackOAuthProviderError(
        'SLACK_AUTH_TEST_INVALID_RESPONSE',
        false,
      );
    }
    if (!parsed.data.ok) {
      throw new SlackOAuthProviderError(
        'SLACK_AUTH_TEST_REJECTED',
        isRetryableSlackError(parsed.data.error),
      );
    }
    return {
      teamId: parsed.data.team_id,
      userId: parsed.data.user_id,
    };
  }

  public async verifyInstaller(
    accessToken: string,
    userId: string,
  ): Promise<SlackInstallerAuthority> {
    const token = printableProviderValue.parse(accessToken);
    const parsedUserId = z
      .string()
      .regex(/^[UW][A-Z0-9]{1,63}$/u)
      .parse(userId);
    const response = await this.post(
      USERS_INFO_URL,
      {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      new URLSearchParams({ user: parsedUserId }),
      'SLACK_USERS_INFO',
    );
    const parsed = userInfoResponseSchema.safeParse(
      await parseBoundedJson(response, 'SLACK_USERS_INFO_INVALID_RESPONSE'),
    );
    if (!parsed.success) {
      throw new SlackOAuthProviderError(
        'SLACK_USERS_INFO_INVALID_RESPONSE',
        false,
      );
    }
    if (!parsed.data.ok) {
      throw new SlackOAuthProviderError(
        'SLACK_USERS_INFO_REJECTED',
        isRetryableSlackError(parsed.data.error),
      );
    }
    return {
      userId: parsed.data.user.id,
      isWorkspaceAdministrator:
        parsed.data.user.is_admin === true ||
        parsed.data.user.is_owner === true ||
        parsed.data.user.is_primary_owner === true,
    };
  }

  private async post(
    url: string,
    headers: Readonly<Record<string, string>>,
    body: URLSearchParams,
    operation: 'SLACK_OAUTH' | 'SLACK_AUTH_TEST' | 'SLACK_USERS_INFO',
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.request(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SlackOAuthProviderError(`${operation}_NETWORK_ERROR`, true);
    }
    if (response.status === 429) {
      throw new SlackOAuthProviderError(`${operation}_RATE_LIMITED`, true);
    }
    if (!response.ok) {
      throw new SlackOAuthProviderError(
        `${operation}_HTTP_ERROR`,
        response.status >= 500,
      );
    }
    return response;
  }
}

function parseHttpsUrl(value: string): string {
  const parsed = z.url().max(2_048).parse(value);
  if (new URL(parsed).protocol !== 'https:') {
    throw new Error('Slack OAuth redirect URI must use HTTPS');
  }
  return parsed;
}

async function parseBoundedJson(
  response: Response,
  errorCode:
    | 'SLACK_OAUTH_INVALID_RESPONSE'
    | 'SLACK_AUTH_TEST_INVALID_RESPONSE'
    | 'SLACK_USERS_INFO_INVALID_RESPONSE',
): Promise<unknown> {
  const text = await readBoundedText(response, errorCode);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SlackOAuthProviderError(errorCode, false);
  }
}

async function readBoundedText(
  response: Response,
  errorCode:
    | 'SLACK_OAUTH_INVALID_RESPONSE'
    | 'SLACK_AUTH_TEST_INVALID_RESPONSE'
    | 'SLACK_USERS_INFO_INVALID_RESPONSE',
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    throw new SlackOAuthProviderError(errorCode, false);
  }
  if (response.body === null) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SlackOAuthProviderError(errorCode, false);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    'utf8',
  );
}

function isRetryableSlackError(error: string): boolean {
  return [
    'fatal_error',
    'internal_error',
    'request_timeout',
    'service_unavailable',
  ].includes(error);
}
