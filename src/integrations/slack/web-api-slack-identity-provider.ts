import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import {
  SlackIdentityProviderError,
  type SlackIdentity,
  type SlackIdentityProvider,
} from '../../application/ports/slack-identity-provider.js';

const TOKEN_URL = 'https://slack.com/api/openid.connect.token';
const USERINFO_URL = 'https://slack.com/api/openid.connect.userInfo';
const JWKS_URL = 'https://slack.com/openid/connect/keys';
const MAX_RESPONSE_BYTES = 256 * 1024;
const printable = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[\x21-\x7e]+$/u);
const tokenResponseSchema = z
  .object({
    ok: z.literal(true),
    access_token: printable,
    id_token: printable,
    token_type: z.string(),
  })
  .passthrough();
const claimsSchema = z
  .object({
    iss: z.literal('https://slack.com'),
    aud: z.union([z.string(), z.array(z.string())]),
    exp: z.number().int(),
    iat: z.number().int(),
    nonce: printable,
  })
  .passthrough();
const userInfoSchema = z
  .object({
    ok: z.literal(true),
    'https://slack.com/team_id': z.string().regex(/^T[A-Z0-9]{1,63}$/u),
    'https://slack.com/user_id': z.string().regex(/^[UW][A-Z0-9]{1,63}$/u),
  })
  .passthrough();
const jwtHeaderSchema = z
  .object({
    alg: z.literal('RS256'),
    kid: z.string().min(1).max(256),
    typ: z.string().optional(),
  })
  .passthrough();
const jwksSchema = z
  .object({
    keys: z
      .array(
        z
          .object({
            kty: z.literal('RSA'),
            kid: z.string().min(1).max(256),
            use: z.literal('sig').optional(),
            alg: z.literal('RS256').optional(),
            n: z.string().min(1).max(4_096),
            e: z.string().min(1).max(32),
          })
          .passthrough(),
      )
      .min(1)
      .max(20),
  })
  .passthrough();

/**
 * Uses Slack's back-channel token and UserInfo endpoints. Identity is trusted
 * only from the authenticated UserInfo response. The ID token is verified
 * against Slack's JWKS before issuer, audience, freshness, and nonce checks.
 */
export class WebApiSlackIdentityProvider implements SlackIdentityProvider {
  private readonly authorization: string;
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(
    private readonly clientId: string,
    clientSecret: string,
    options: {
      readonly request?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {
    const id = printable.max(256).parse(clientId);
    const secret = printable.max(256).parse(clientSecret);
    if (id.includes(':'))
      throw new Error('Slack client ID must not contain a colon');
    this.authorization = `Basic ${Buffer.from(`${id}:${secret}`, 'utf8').toString('base64')}`;
    this.request = options.request ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly redirectUri: string;
    readonly expectedNonceSha256: string;
  }): Promise<SlackIdentity> {
    const tokenResponse = await this.fetchJson(TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: this.authorization,
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: new URLSearchParams({
        code: printable.parse(input.code),
        redirect_uri: httpsUrl(input.redirectUri),
      }),
    });
    const token = tokenResponseSchema.safeParse(tokenResponse);
    if (!token.success) throw new SlackIdentityProviderError(false);
    const claims = await this.verifyIdToken(token.data.id_token);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Math.floor(Date.now() / 1_000);
    if (
      !audiences.includes(this.clientId) ||
      claims.exp <= now ||
      claims.iat > now + 60 ||
      sha256(claims.nonce) !== input.expectedNonceSha256
    ) {
      throw new SlackIdentityProviderError(false);
    }
    const userInfoResponse = await this.fetchJson(USERINFO_URL, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token.data.access_token}`,
      },
    });
    const userInfo = userInfoSchema.safeParse(userInfoResponse);
    if (!userInfo.success) throw new SlackIdentityProviderError(false);
    return {
      teamId: userInfo.data['https://slack.com/team_id'],
      userId: userInfo.data['https://slack.com/user_id'],
    };
  }

  private async verifyIdToken(
    idToken: string,
  ): Promise<z.infer<typeof claimsSchema>> {
    const parts = idToken.split('.');
    if (
      parts.length !== 3 ||
      parts[0] === undefined ||
      parts[1] === undefined ||
      parts[2] === undefined
    ) {
      throw new SlackIdentityProviderError(false);
    }
    let header: z.infer<typeof jwtHeaderSchema>;
    try {
      header = jwtHeaderSchema.parse(
        JSON.parse(
          Buffer.from(parts[0], 'base64url').toString('utf8'),
        ) as unknown,
      );
    } catch {
      throw new SlackIdentityProviderError(false);
    }
    const jwks = jwksSchema.safeParse(
      await this.fetchJson(JWKS_URL, {
        method: 'GET',
        headers: { accept: 'application/json' },
      }),
    );
    if (!jwks.success) throw new SlackIdentityProviderError(false);
    const jwk = jwks.data.keys.find(
      (candidate) => candidate.kid === header.kid,
    );
    if (jwk === undefined) throw new SlackIdentityProviderError(false);
    let valid = false;
    try {
      valid = verify(
        'RSA-SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
        createPublicKey({ key: jwk, format: 'jwk' }),
        Buffer.from(parts[2], 'base64url'),
      );
    } catch {
      throw new SlackIdentityProviderError(false);
    }
    if (!valid) throw new SlackIdentityProviderError(false);
    return parseClaims(parts[1]);
  }

  private async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SlackIdentityProviderError(true);
    }
    if (!response.ok)
      throw new SlackIdentityProviderError(
        response.status === 429 || response.status >= 500,
      );
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_RESPONSE_BYTES)
      throw new SlackIdentityProviderError(false);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES)
      throw new SlackIdentityProviderError(false);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SlackIdentityProviderError(false);
    }
  }
}

function parseClaims(payload: string): z.infer<typeof claimsSchema> {
  try {
    return claimsSchema.parse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown,
    );
  } catch {
    throw new SlackIdentityProviderError(false);
  }
}
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function httpsUrl(value: string): string {
  const url = new URL(z.url().max(2_048).parse(value));
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    throw new Error('Slack redirect URI must use HTTPS');
  return url.toString();
}
