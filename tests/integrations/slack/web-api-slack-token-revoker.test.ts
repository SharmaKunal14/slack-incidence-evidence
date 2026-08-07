import { describe, expect, it, vi } from 'vitest';
import { WebApiSlackTokenRevoker } from '../../../src/integrations/slack/web-api-slack-token-revoker.js';

describe('WebApiSlackTokenRevoker', () => {
  it('revokes with a bounded bearer-authenticated Slack request', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    const revoker = new WebApiSlackTokenRevoker({ request, timeoutMs: 1_000 });

    await expect(revoker.revoke('xoxb-secret')).resolves.toBe('REVOKED');
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://slack.com/api/auth.revoke',
    );
    const requestOptions = request.mock.calls[0]?.[1];
    expect(requestOptions?.method).toBe('POST');
    expect(requestOptions?.redirect).toBe('error');
    expect(new Headers(requestOptions?.headers).get('authorization')).toBe(
      'Bearer xoxb-secret',
    );
  });

  it('treats an already revoked token as an idempotent success', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: 'token_revoked' })),
      );

    await expect(
      new WebApiSlackTokenRevoker({ request }).revoke('xoxb-secret'),
    ).resolves.toBe('ALREADY_REVOKED');
  });

  it('classifies rate limiting as retryable', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 429 }));

    await expect(
      new WebApiSlackTokenRevoker({ request }).revoke('xoxb-secret'),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('rejects oversized responses', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{}', {
        headers: { 'content-length': String(64 * 1024 + 1) },
      }),
    );

    await expect(
      new WebApiSlackTokenRevoker({ request }).revoke('xoxb-secret'),
    ).rejects.toMatchObject({ retryable: false });
  });
});
