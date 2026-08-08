import { describe, expect, it, vi } from 'vitest';
import {
  SlackOAuthProviderError,
  WebApiSlackOAuthProvider,
} from '../../../src/integrations/slack/web-api-slack-oauth-provider.js';

const oauthSuccess = {
  ok: true,
  access_token: 'xoxe.xoxb-access',
  token_type: 'bot',
  scope:
    'users:read,commands,chat:write,channels:read,channels:history,app_mentions:read',
  bot_user_id: 'U001',
  app_id: 'A001',
  team: { id: 'T001', name: 'Acme Engineering' },
  enterprise: { id: 'E001', name: 'Acme Grid' },
  authed_user: { id: 'W002' },
  refresh_token: 'xoxe-refresh',
  expires_in: 43_200,
  is_enterprise_install: false,
};

describe('WebApiSlackOAuthProvider', () => {
  it('exchanges a code with Basic auth and keeps credentials out of the body', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(oauthSuccess)));
    const provider = new WebApiSlackOAuthProvider(
      { clientId: '123.456', clientSecret: 'client-secret-value' },
      { request, timeoutMs: 2_000 },
    );

    await expect(
      provider.exchangeCode({
        code: 'temporary-code',
        redirectUri: 'https://app.example.com/onboarding/slack/callback',
      }),
    ).resolves.toMatchObject({
      teamId: 'T001',
      authedUserId: 'W002',
      isEnterpriseInstall: false,
    });

    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe('https://slack.com/api/oauth.v2.access');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from(
        '123.456:client-secret-value',
      ).toString('base64')}`,
    });
    const body = init?.body as URLSearchParams;
    expect(body.get('code')).toBe('temporary-code');
    expect(body.get('redirect_uri')).toBe(
      'https://app.example.com/onboarding/slack/callback',
    );
    expect(body.has('client_id')).toBe(false);
    expect(body.has('client_secret')).toBe(false);
  });

  it('accepts a W-prefixed bot identity from auth.test', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, team_id: 'T001', user_id: 'W001' }),
        ),
      );
    const provider = new WebApiSlackOAuthProvider(
      { clientId: '123.456', clientSecret: 'client-secret-value' },
      { request },
    );

    await expect(provider.verifyBot('xoxb-access')).resolves.toEqual({
      teamId: 'T001',
      userId: 'W001',
    });
    expect(request.mock.calls[0]?.[0]).toBe('https://slack.com/api/auth.test');
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer xoxb-access',
    });
  });

  it('verifies installer authority without trusting the OAuth response alone', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          user: { id: 'W002', is_admin: true, is_owner: false },
        }),
      ),
    );
    const provider = new WebApiSlackOAuthProvider(
      { clientId: '123.456', clientSecret: 'client-secret-value' },
      { request },
    );

    await expect(
      provider.verifyInstaller('xoxb-access', 'W002'),
    ).resolves.toEqual({
      userId: 'W002',
      isWorkspaceAdministrator: true,
    });
    expect(request.mock.calls[0]?.[0]).toBe('https://slack.com/api/users.info');
    expect(
      (request.mock.calls[0]?.[1]?.body as URLSearchParams).get('user'),
    ).toBe('W002');
  });

  it('maps rate limits and bounded provider errors without exposing responses', async () => {
    const rateLimitedRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 429 }));
    const rateLimited = new WebApiSlackOAuthProvider(
      { clientId: '123.456', clientSecret: 'client-secret-value' },
      { request: rateLimitedRequest },
    );
    await expect(rateLimited.verifyBot('xoxb-access')).rejects.toMatchObject({
      code: 'SLACK_AUTH_TEST_RATE_LIMITED',
      retryable: true,
      message: 'Slack OAuth provider request failed',
    });

    const rejectedRequest = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'invalid_code' }), {
        status: 200,
      }),
    );
    const rejected = new WebApiSlackOAuthProvider(
      { clientId: '123.456', clientSecret: 'client-secret-value' },
      { request: rejectedRequest },
    );
    await expect(
      rejected.exchangeCode({
        code: 'temporary-code',
        redirectUri: 'https://app.example.com/onboarding/slack/callback',
      }),
    ).rejects.toEqual(
      new SlackOAuthProviderError('SLACK_OAUTH_REQUEST_REJECTED', false),
    );
  });

  it('rejects oversized or malformed JSON responses', async () => {
    const oversized = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('x'.repeat(256 * 1024 + 1)));
    const provider = new WebApiSlackOAuthProvider(
      { clientId: '123.456', clientSecret: 'client-secret-value' },
      { request: oversized },
    );

    await expect(provider.verifyBot('xoxb-access')).rejects.toMatchObject({
      code: 'SLACK_AUTH_TEST_INVALID_RESPONSE',
      retryable: false,
    });
  });
});
