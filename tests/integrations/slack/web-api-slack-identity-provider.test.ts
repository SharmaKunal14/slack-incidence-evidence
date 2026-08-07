import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WebApiSlackIdentityProvider } from '../../../src/integrations/slack/web-api-slack-identity-provider.js';

const clientId = '123.456';
const nonce = 'n'.repeat(43);

describe('WebApiSlackIdentityProvider', () => {
  it('verifies the Slack signature, OIDC claims, nonce, and UserInfo identity', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const jwk = publicKey.export({ format: 'jwk' });
    const idToken = jwt(privateKey, nonce);
    const request = vi.fn<typeof fetch>((url) => {
      const value = requestUrl(url);
      if (value.endsWith('/openid.connect.token')) {
        return Promise.resolve(
          json({
            ok: true,
            access_token: 'xoxp-safe',
            token_type: 'Bearer',
            id_token: idToken,
          }),
        );
      }
      if (value.endsWith('/openid/connect/keys')) {
        return Promise.resolve(
          json({
            keys: [{ ...jwk, kid: 'key-1', use: 'sig', alg: 'RS256' }],
          }),
        );
      }
      return Promise.resolve(
        json({
          ok: true,
          'https://slack.com/team_id': 'T001',
          'https://slack.com/user_id': 'U001',
        }),
      );
    });
    const provider = new WebApiSlackIdentityProvider(
      clientId,
      'client-secret',
      { request },
    );

    await expect(
      provider.exchangeCode({
        code: 'authorization-code',
        redirectUri: 'https://app.example.test/callback',
        expectedNonceSha256: sha256(nonce),
      }),
    ).resolves.toEqual({ teamId: 'T001', userId: 'U001' });
  });

  it('rejects a token whose signature does not match Slack JWKS', async () => {
    const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const advertised = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const request = vi.fn<typeof fetch>((url) =>
      Promise.resolve(
        requestUrl(url).endsWith('/openid.connect.token')
          ? json({
              ok: true,
              access_token: 'xoxp-safe',
              token_type: 'Bearer',
              id_token: jwt(signing.privateKey, nonce),
            })
          : json({
              keys: [
                {
                  ...advertised.publicKey.export({ format: 'jwk' }),
                  kid: 'key-1',
                  use: 'sig',
                  alg: 'RS256',
                },
              ],
            }),
      ),
    );
    const provider = new WebApiSlackIdentityProvider(
      clientId,
      'client-secret',
      { request },
    );
    await expect(
      provider.exchangeCode({
        code: 'authorization-code',
        redirectUri: 'https://app.example.test/callback',
        expectedNonceSha256: sha256(nonce),
      }),
    ).rejects.toMatchObject({ retryable: false });
  });
});

function jwt(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  tokenNonce: string,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: 'key-1', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://slack.com',
      aud: clientId,
      sub: 'U001',
      nonce: tokenNonce,
      iat: Math.floor(Date.now() / 1_000) - 1,
      exp: Math.floor(Date.now() / 1_000) + 300,
    }),
  ).toString('base64url');
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`, 'ascii'),
    privateKey,
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
function requestUrl(value: string | URL | Request): string {
  if (typeof value === 'string') return value;
  return value instanceof URL ? value.href : value.url;
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
