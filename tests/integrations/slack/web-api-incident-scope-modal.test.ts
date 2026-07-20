import { describe, expect, it, vi } from 'vitest';
import { SlackWebApiIncidentScopeModal } from '../../../src/integrations/slack/web-api-incident-scope-modal.js';

describe('Slack incident scope modal', () => {
  it('opens a public-channel-only bounded modal without exposing the bot token', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const modal = new SlackWebApiIncidentScopeModal(
      { workspaceId: 'T001', botToken: 'xoxb-sensitive-token' },
      { request },
    );

    await modal.open({
      triggerId: 'trigger-1',
      workspaceId: 'T001',
      userId: 'U001',
      channelId: 'C001',
      messageTs: '1721178000.000100',
      defaultStartedAt: new Date('2026-07-20T02:00:00Z'),
      defaultEndedAt: new Date('2026-07-20T03:00:00Z'),
      evidenceRetentionDays: 30,
    });

    const [, init] = request.mock.calls[0] ?? [];
    if (typeof init?.body !== 'string') {
      throw new Error('Expected Slack modal JSON string body');
    }
    const body = JSON.parse(init.body) as {
      readonly view: { readonly blocks: readonly Record<string, unknown>[] };
    };
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe('error');
    expect(JSON.stringify(body)).not.toContain('xoxb-sensitive-token');
    expect(JSON.stringify(body)).toContain('"include":["public"]');
    expect(JSON.stringify(body)).toContain('"max_selected_items":4');
    expect(JSON.stringify(body)).toContain('30-day retention deadline');
    expect(JSON.stringify(body)).toContain(
      'operators must configure the documented deletion process before production use',
    );
  });
});
