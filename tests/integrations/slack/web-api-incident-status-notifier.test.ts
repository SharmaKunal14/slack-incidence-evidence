import { describe, expect, it, vi } from 'vitest';
import {
  SlackRateLimitError,
  SlackWebApiError,
  SlackWebApiIncidentStatusNotifier,
} from '../../../src/integrations/slack/web-api-incident-status-notifier.js';

const incidentId = '2c6a2f4a-f762-41e9-9620-a07abdaa5c48';
const botToken = 'xoxb-do-not-log-this-token';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SlackWebApiIncidentStatusNotifier', () => {
  it('posts a plain-text thread reply with a stable idempotency ID', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ ok: true, channel: 'C001', ts: '1721178001.000200' }),
      );
    const notifier = new SlackWebApiIncidentStatusNotifier(
      { workspaceId: 'T001', botToken },
      { request, timeoutMs: 100 },
    );

    await expect(
      notifier.notifyAccepted({
        workspaceId: 'T001',
        incidentId,
        channelId: 'C001',
        threadTs: '1721178000.000100',
      }),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
    });
    if (typeof init?.body !== 'string') {
      throw new Error('Expected Slack request body to be JSON text');
    }
    expect(JSON.parse(init.body)).toEqual({
      channel: 'C001',
      thread_ts: '1721178000.000100',
      client_msg_id: incidentId,
      text: [
        'Incident review accepted.',
        `Reference: ${incidentId}`,
        'Status: collecting evidence.',
      ].join('\n'),
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(init.body).not.toContain(botToken);
  });

  it('rejects a cross-workspace notification before making a request', async () => {
    const request = vi.fn<typeof fetch>();
    const notifier = new SlackWebApiIncidentStatusNotifier(
      { workspaceId: 'T001', botToken },
      { request },
    );

    await expect(
      notifier.notifyAccepted({
        workspaceId: 'T999',
        incidentId,
        channelId: 'C001',
        threadTs: '1721178000.000100',
      }),
    ).rejects.toMatchObject({ code: 'SLACK_WORKSPACE_MISMATCH' });
    expect(request).not.toHaveBeenCalled();
  });

  it('returns a bounded rate-limit error without retrying internally', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '30' },
      }),
    );
    const notifier = new SlackWebApiIncidentStatusNotifier(
      { workspaceId: 'T001', botToken },
      { request },
    );

    const failure = notifier.notifyAccepted({
      workspaceId: 'T001',
      incidentId,
      channelId: 'C001',
      threadTs: '1721178000.000100',
    });

    await expect(failure).rejects.toBeInstanceOf(SlackRateLimitError);
    await expect(failure).rejects.toMatchObject({
      code: 'SLACK_RATE_LIMITED',
      retryAfterSeconds: 30,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects Slack errors and malformed success responses', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error: 'not_in_channel' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, channel: 'C999', ts: '1721178001.000200' }),
      );
    const notifier = new SlackWebApiIncidentStatusNotifier(
      { workspaceId: 'T001', botToken },
      { request },
    );
    const input = {
      workspaceId: 'T001',
      incidentId,
      channelId: 'C001',
      threadTs: '1721178000.000100',
    };

    await expect(notifier.notifyAccepted(input)).rejects.toMatchObject({
      code: 'SLACK_NOT_IN_CHANNEL',
    });
    await expect(notifier.notifyAccepted(input)).rejects.toMatchObject({
      code: 'SLACK_RESPONSE_CHANNEL_MISMATCH',
    });
  });

  it('does not expose a token through its safe error', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`request failed for ${botToken}`));
    const notifier = new SlackWebApiIncidentStatusNotifier(
      { workspaceId: 'T001', botToken },
      { request },
    );

    let error: unknown;
    try {
      await notifier.notifyAccepted({
        workspaceId: 'T001',
        incidentId,
        channelId: 'C001',
        threadTs: '1721178000.000100',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SlackWebApiError);
    expect(String(error)).not.toContain(botToken);
  });
});
