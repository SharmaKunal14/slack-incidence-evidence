import { describe, expect, it, vi } from 'vitest';
import { SlackWebApiChannelAccessVerifier } from '../../../src/integrations/slack/web-api-slack-channel-access-verifier.js';

const installation = { workspaceId: 'T001', botToken: 'xoxb-secret' };

describe('Slack channel access verifier', () => {
  it('checks bounded channel metadata without reading message history', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        channel: {
          id: 'C001',
          name: 'incident-room',
          is_channel: true,
          is_private: false,
          is_ext_shared: false,
          is_org_shared: false,
          is_member: true,
        },
      }),
    );

    await expect(
      new SlackWebApiChannelAccessVerifier(installation, request).verify(
        'T001',
        ['C001'],
      ),
    ).resolves.toEqual([
      { channelId: 'C001', accessible: true, displayName: 'incident-room' },
    ]);

    const requestedUrl = request.mock.calls[0]?.[0];
    if (!(requestedUrl instanceof URL)) {
      throw new Error('Expected the verifier to request a URL');
    }
    const url = new URL(requestedUrl);
    expect(url.pathname).toBe('/api/conversations.info');
    expect(url.searchParams.get('channel')).toBe('C001');
    expect(url.pathname).not.toContain('history');
  });

  it('returns actionable failures for non-member and unsupported channels', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          channel: {
            id: 'C001',
            name: 'payments',
            is_channel: true,
            is_private: false,
            is_ext_shared: false,
            is_org_shared: false,
            is_member: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          channel: {
            id: 'C002',
            name: 'private-response',
            is_channel: true,
            is_private: true,
            is_ext_shared: false,
            is_org_shared: false,
            is_member: true,
          },
        }),
      );

    await expect(
      new SlackWebApiChannelAccessVerifier(installation, request).verify(
        'T001',
        ['C001', 'C002'],
      ),
    ).resolves.toEqual([
      {
        channelId: 'C001',
        accessible: false,
        code: 'APP_NOT_IN_CHANNEL',
        retryable: false,
        displayName: 'payments',
      },
      {
        channelId: 'C002',
        accessible: false,
        code: 'UNSUPPORTED_CHANNEL',
        retryable: false,
        displayName: 'private-response',
      },
    ]);
  });

  it('fails closed on workspace mismatch without sending the bot token', async () => {
    const request = vi.fn<typeof fetch>();
    const result = await new SlackWebApiChannelAccessVerifier(
      installation,
      request,
    ).verify('T999', ['C001']);

    expect(result[0]).toMatchObject({
      accessible: false,
      code: 'WORKSPACE_RECONNECT_REQUIRED',
    });
    expect(request).not.toHaveBeenCalled();
  });
});
