import { describe, expect, it, vi } from 'vitest';
import { WebApiSlackAppUninstaller } from '../../../src/integrations/slack/web-api-slack-app-uninstaller.js';

const configuration = {
  clientId: '123.456',
  clientSecret: 'client-secret-value',
};

describe('WebApiSlackAppUninstaller', () => {
  it('uninstalls the complete app installation with backend credentials', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    const uninstaller = new WebApiSlackAppUninstaller(configuration, {
      request,
      timeoutMs: 1_000,
    });

    await expect(uninstaller.uninstall('xoxb-secret')).resolves.toBe(
      'UNINSTALLED',
    );
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://slack.com/api/apps.uninstall',
    );
    const requestOptions = request.mock.calls[0]?.[1];
    expect(requestOptions?.method).toBe('POST');
    expect(requestOptions?.redirect).toBe('error');
    expect(new Headers(requestOptions?.headers).get('authorization')).toBe(
      'Bearer xoxb-secret',
    );
    if (!(requestOptions?.body instanceof URLSearchParams)) {
      throw new Error('Expected a URL-encoded Slack uninstall request');
    }
    const body = requestOptions.body;
    expect(body.get('client_id')).toBe('123.456');
    expect(body.get('client_secret')).toBe('client-secret-value');
    expect(body.has('token')).toBe(false);
  });

  it('treats a token revoked by a previous uninstall as idempotent success', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: 'token_revoked' })),
      );

    await expect(
      new WebApiSlackAppUninstaller(configuration, { request }).uninstall(
        'xoxb-secret',
      ),
    ).resolves.toBe('ALREADY_UNINSTALLED');
  });

  it('does not mistake ambiguous invalid authentication for an uninstall', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: 'invalid_auth' })),
      );

    await expect(
      new WebApiSlackAppUninstaller(configuration, { request }).uninstall(
        'xoxb-secret',
      ),
    ).rejects.toMatchObject({ retryable: false });
  });

  it('classifies rate limiting as retryable', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 429 }));

    await expect(
      new WebApiSlackAppUninstaller(configuration, { request }).uninstall(
        'xoxb-secret',
      ),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('rejects oversized responses', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{}', {
        headers: { 'content-length': String(64 * 1024 + 1) },
      }),
    );

    await expect(
      new WebApiSlackAppUninstaller(configuration, { request }).uninstall(
        'xoxb-secret',
      ),
    ).rejects.toMatchObject({ retryable: false });
  });
});
