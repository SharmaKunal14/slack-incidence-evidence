import { describe, expect, it, vi } from 'vitest';
import { SlackThreadWebApiSource } from '../../../src/integrations/slack/web-api-slack-thread-source.js';

const botToken = 'xoxb-do-not-log-this-token';
const input = {
  workspaceId: 'T001',
  channelId: 'C001',
  threadTs: '1721178000.000100',
};

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('SlackThreadWebApiSource', () => {
  it('fetches one bounded page, filters operational replies, and resolves permalinks', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          messages: [
            {
              type: 'message',
              ts: '1721178000.000100',
              text: 'Checkout errors began after deployment.',
              user: 'U001',
              edited: { ts: '1721178010.000200' },
            },
            {
              type: 'message',
              ts: '1721178001.000200',
              text: 'Incident review accepted.',
              bot_id: 'B001',
              metadata: { event_type: 'incident_copilot_status' },
            },
          ],
          response_metadata: { next_cursor: 'cursor-2' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          channel: 'C001',
          permalink:
            'https://workspace.slack.com/archives/C001/p1721178000000100',
        }),
      );
    const source = new SlackThreadWebApiSource(
      { workspaceId: 'T001', botToken },
      { request, timeoutMs: 100 },
    );

    await expect(source.fetchPage(input)).resolves.toEqual({
      outcome: 'page',
      messages: [
        {
          messageTs: '1721178000.000100',
          occurredAt: new Date('2024-07-17T01:00:00.000Z'),
          text: 'Checkout errors began after deployment.',
          permalink:
            'https://workspace.slack.com/archives/C001/p1721178000000100',
          authorId: 'U001',
          editedTs: '1721178010.000200',
        },
      ],
      nextCursor: 'cursor-2',
    });

    expect(request).toHaveBeenCalledTimes(2);
    const [repliesUrl, repliesInit] = request.mock.calls[0] ?? [];
    expect(repliesUrl).toBeInstanceOf(URL);
    const url = repliesUrl as URL;
    expect(url.origin + url.pathname).toBe(
      'https://slack.com/api/conversations.replies',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      channel: 'C001',
      ts: '1721178000.000100',
      limit: '15',
      include_all_metadata: 'true',
    });
    expect(repliesInit).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${botToken}`,
      },
    });
  });

  it('returns Slack retry timing without retrying inside the Lambda', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('', {
        status: 429,
        headers: { 'retry-after': '30' },
      }),
    );
    const source = new SlackThreadWebApiSource(
      { workspaceId: 'T001', botToken },
      { request },
    );

    await expect(source.fetchPage(input)).resolves.toEqual({
      outcome: 'rate_limited',
      retryAfterSeconds: 30,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('classifies missing scope as a terminal collection failure', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: false, error: 'missing_scope' }));
    const source = new SlackThreadWebApiSource(
      { workspaceId: 'T001', botToken },
      { request },
    );

    await expect(source.fetchPage(input)).rejects.toMatchObject({
      code: 'SLACK_MISSING_SCOPE',
      retryable: false,
    });
  });

  it('continues without a permalink when Slack no longer resolves a message', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          messages: [
            {
              type: 'message',
              ts: '1721178000.000100',
              text: 'Root message',
              user: 'U001',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error: 'message_not_found' }),
      );
    const source = new SlackThreadWebApiSource(
      { workspaceId: 'T001', botToken },
      { request },
    );

    await expect(source.fetchPage(input)).resolves.toMatchObject({
      outcome: 'page',
      messages: [{ permalink: null }],
      nextCursor: null,
    });
  });

  it('accepts a full page of replies when Slack also includes the thread parent', async () => {
    const messages = Array.from({ length: 16 }, (_, index) => ({
      type: 'message',
      ts: `1721178000.${String(index + 100).padStart(6, '0')}`,
      text: `Message ${index + 1}`,
      user: 'U001',
    }));
    const request = vi.fn<typeof fetch>().mockImplementation((url) => {
      if (!(url instanceof URL)) {
        throw new TypeError('Expected Slack source to use a URL request');
      }
      const requestUrl = url;
      if (requestUrl.pathname === '/api/conversations.replies') {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            messages,
            response_metadata: { next_cursor: 'cursor-2' },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          ok: true,
          channel: 'C001',
          permalink: `https://workspace.slack.com/archives/C001/p${requestUrl.searchParams.get('message_ts')}`,
        }),
      );
    });
    const source = new SlackThreadWebApiSource(
      { workspaceId: 'T001', botToken },
      { request },
    );

    const result = await source.fetchPage(input);

    expect(result).toMatchObject({
      outcome: 'page',
      nextCursor: 'cursor-2',
    });
    expect(result.outcome === 'page' && result.messages).toHaveLength(16);
    expect(request).toHaveBeenCalledTimes(17);
  });

  it('rejects a Slack response above the parent-plus-page bound', async () => {
    const messages = Array.from({ length: 17 }, (_, index) => ({
      type: 'message',
      ts: `1721178000.${String(index + 100).padStart(6, '0')}`,
      text: `Message ${index + 1}`,
      user: 'U001',
    }));
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, messages }));
    const source = new SlackThreadWebApiSource(
      { workspaceId: 'T001', botToken },
      { request },
    );

    await expect(source.fetchPage(input)).rejects.toMatchObject({
      code: 'SLACK_INVALID_RESPONSE',
      retryable: true,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects a cross-workspace request before sending the bot token', async () => {
    const request = vi.fn<typeof fetch>();
    const source = new SlackThreadWebApiSource(
      { workspaceId: 'T001', botToken },
      { request },
    );

    await expect(
      source.fetchPage({ ...input, workspaceId: 'T999' }),
    ).rejects.toMatchObject({
      code: 'SLACK_WORKSPACE_MISMATCH',
      retryable: false,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a response body that exceeds the streaming memory bound', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const source = new SlackThreadWebApiSource(
      { workspaceId: 'T001', botToken },
      { request },
    );

    await expect(source.fetchPage(input)).rejects.toMatchObject({
      code: 'SLACK_RESPONSE_TOO_LARGE',
      retryable: true,
    });
  });
});
