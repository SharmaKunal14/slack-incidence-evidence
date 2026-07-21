import { describe, expect, it, vi } from 'vitest';
import { compromisedWafScenario } from '../../src/demo/slack-cybersecurity-scenario.js';
import { seedSlackIncident } from '../../src/demo/slack-incident-seeder.js';

const MAYA_TOKEN = 'xoxp-maya-test-token';
const ARJUN_TOKEN = 'xoxp-arjun-test-token';
const WORKSPACE_ID = 'T12345678';

describe('seedSlackIncident', () => {
  it('creates channels, invites the second user, and preserves thread roots', async () => {
    const calls: Array<{
      method: string;
      token: string;
      body: Record<string, unknown>;
    }> = [];
    let channelNumber = 0;
    let messageNumber = 0;
    const channelIds = new Map<string, string>();
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const inputUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = inputUrl.slice(inputUrl.lastIndexOf('/') + 1);
      const token =
        new Headers(init?.headers).get('authorization')?.slice(7) ?? '';
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      calls.push({ method, token, body });

      if (method === 'auth.test') {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            team_id: WORKSPACE_ID,
            user_id: token === MAYA_TOKEN ? 'UMAYA123' : 'UARJUN12',
            user: token === MAYA_TOKEN ? 'maya.actual' : 'arjun.actual',
            url: 'https://onrecord-demo.slack.com/',
          }),
        );
      }
      if (method === 'conversations.create') {
        channelNumber += 1;
        const name = String(body['name']);
        const id = `CDEMO00${channelNumber}`;
        channelIds.set(name, id);
        return Promise.resolve(
          jsonResponse({ ok: true, channel: { id, name } }),
        );
      }
      if (method === 'conversations.invite') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      messageNumber += 1;
      return Promise.resolve(
        jsonResponse({
          ok: true,
          channel: body['channel'],
          ts: `1721280000.${String(messageNumber).padStart(6, '0')}`,
        }),
      );
    });

    const result = await seedSlackIncident(
      {
        workspaceId: WORKSPACE_ID,
        mayaToken: MAYA_TOKEN,
        arjunToken: ARJUN_TOKEN,
        channelSuffix: 'test',
        delayMs: 0,
        onRecordBotUserId: 'UONRECORD',
      },
      { request, sleep: () => Promise.resolve() },
    );

    expect(result.messageCount).toBe(compromisedWafScenario.length);
    expect(result.anchors).toHaveLength(5);
    expect(
      calls.filter((call) => call.method === 'conversations.create'),
    ).toHaveLength(3);
    expect(
      calls.filter((call) => call.method === 'conversations.invite'),
    ).toHaveLength(6);
    expect(
      calls
        .filter((call) => call.method === 'conversations.invite')
        .map((call) => call.body['users']),
    ).toContain('UONRECORD');
    const postCalls = calls.filter(
      (call) => call.method === 'chat.postMessage',
    );
    expect(postCalls).toHaveLength(compromisedWafScenario.length);

    const declaredIndex = compromisedWafScenario.findIndex(
      (message) => message.id === 'incident-declared',
    );
    const replyIndex = compromisedWafScenario.findIndex(
      (message) => message.id === 'security-correlation',
    );
    expect(postCalls[replyIndex]?.body['thread_ts']).toBe(
      `1721280000.${String(declaredIndex + 1).padStart(6, '0')}`,
    );
    expect(channelIds.size).toBe(3);
  });

  it('refuses tokens belonging to a different workspace before creating channels', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      const token =
        new Headers(init?.headers).get('authorization')?.slice(7) ?? '';
      return Promise.resolve(
        jsonResponse({
          ok: true,
          team_id: token === MAYA_TOKEN ? WORKSPACE_ID : 'TOTHER123',
          user_id: token === MAYA_TOKEN ? 'UMAYA123' : 'UARJUN12',
          user: token === MAYA_TOKEN ? 'maya.actual' : 'arjun.actual',
          url: 'https://onrecord-demo.slack.com/',
        }),
      );
    });

    await expect(
      seedSlackIncident(
        {
          workspaceId: WORKSPACE_ID,
          mayaToken: MAYA_TOKEN,
          arjunToken: ARJUN_TOKEN,
          delayMs: 0,
        },
        { request, sleep: () => Promise.resolve() },
      ),
    ).rejects.toThrow(/both tokens must belong/u);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
