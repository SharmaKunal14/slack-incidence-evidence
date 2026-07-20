import { describe, expect, it, vi } from 'vitest';
import type { SlackChannelSourceError } from '../../../src/application/ports/slack-channel-source.js';
import { SlackChannelWebApiSource } from '../../../src/integrations/slack/web-api-slack-channel-source.js';

const input = {
  workspaceId: 'T001',
  channelId: 'C001',
  phase: 'CHANNEL' as const,
  oldest: new Date('2026-07-20T02:00:00Z'),
  latest: new Date('2026-07-20T03:00:00Z'),
  includeDisplayName: true,
};

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('SlackChannelWebApiSource', () => {
  it('server-side authorizes a public bot-member channel and enforces the requested window', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          ok: true,
          channel: {
            id: 'C001',
            name: 'incident-checkout',
            is_channel: true,
            is_private: false,
            is_member: true,
            is_ext_shared: false,
            is_org_shared: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          ok: true,
          messages: [
            { type: 'message', ts: '1784514600.000100', text: 'inside' },
            { type: 'message', ts: '1784511000.000100', text: 'outside' },
          ],
          response_metadata: { next_cursor: '' },
        }),
      )
      .mockResolvedValueOnce(
        json({
          ok: true,
          channel: 'C001',
          permalink: 'https://acme.slack.com/archives/C001/p1784514600000100',
        }),
      );
    const source = new SlackChannelWebApiSource(
      { workspaceId: 'T001', botToken: 'xoxb-test' },
      { request },
    );

    await expect(source.fetchPage(input)).resolves.toMatchObject({
      outcome: 'page',
      displayName: 'incident-checkout',
      messages: [{ text: 'inside' }],
      nextCursor: null,
    });
    const historyRequest = request.mock.calls[1]?.[0];
    const historyUrl =
      historyRequest instanceof URL
        ? historyRequest
        : new URL(
            typeof historyRequest === 'string'
              ? historyRequest
              : (historyRequest?.url ?? ''),
          );
    expect(historyUrl.searchParams.get('oldest')).toBe('1784512800.000');
    expect(historyUrl.searchParams.get('latest')).toBe('1784516400.000');
    expect(historyUrl.searchParams.get('limit')).toBe('15');
  });

  it('fails closed before history retrieval when the bot is not a channel member', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        ok: true,
        channel: {
          id: 'C001',
          name: 'engineering-general',
          is_channel: true,
          is_private: false,
          is_member: false,
          is_ext_shared: false,
          is_org_shared: false,
        },
      }),
    );
    const source = new SlackChannelWebApiSource(
      { workspaceId: 'T001', botToken: 'xoxb-test' },
      { request },
    );

    await expect(source.fetchPage(input)).rejects.toMatchObject({
      code: 'SLACK_CHANNEL_ACCESS_UNAVAILABLE',
      retryable: false,
      terminalStatus: 'INACCESSIBLE',
    } satisfies Partial<SlackChannelSourceError>);
    expect(request).toHaveBeenCalledOnce();
  });

  it('returns provider-directed waiting without reading a response body', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('', { status: 429, headers: { 'retry-after': '73' } }),
      );
    const source = new SlackChannelWebApiSource(
      { workspaceId: 'T001', botToken: 'xoxb-test' },
      { request },
    );

    await expect(source.fetchPage(input)).resolves.toEqual({
      outcome: 'rate_limited',
      retryAfterSeconds: 73,
    });
  });
});
