import { describe, expect, it, vi } from 'vitest';
import { SlackIncidentParticipantIdentitySource } from '../../../src/integrations/slack/web-api-incident-participant-identity-source.js';

describe('SlackIncidentParticipantIdentitySource', () => {
  it('resolves only requested users without requesting email fields', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          user: {
            id: 'U12345678',
            name: 'spatel',
            profile: {
              real_name: 'Sarah Patel',
              display_name: 'Sarah',
              email: 'must-not-be-used@example.com',
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const source = new SlackIncidentParticipantIdentitySource(
      { workspaceId: 'T12345678', botToken: 'xoxb-test' },
      { request },
    );

    await expect(source.resolve('T12345678', ['U12345678'])).resolves.toEqual([
      {
        externalId: 'U12345678',
        aliases: ['spatel', 'Sarah Patel', 'Sarah'],
      },
    ]);
    const url = request.mock.calls[0]?.[0];
    expect(url).toBeInstanceOf(URL);
    if (!(url instanceof URL)) {
      throw new Error('Expected Slack request URL');
    }
    expect(url.toString()).toContain('users.info');
    expect(url.toString()).toContain('user=U12345678');
    expect(url.toString()).not.toContain('email');
  });

  it('fails closed on Slack rate limiting', async () => {
    const source = new SlackIncidentParticipantIdentitySource(
      { workspaceId: 'T12345678', botToken: 'xoxb-test' },
      {
        request: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('', { status: 429 })),
      },
    );

    await expect(
      source.resolve('T12345678', ['U12345678']),
    ).rejects.toMatchObject({
      code: 'SLACK_IDENTITY_RATE_LIMITED',
      retryable: true,
    });
  });
});
