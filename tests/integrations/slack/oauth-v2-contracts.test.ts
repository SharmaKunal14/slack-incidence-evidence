import { describe, expect, it } from 'vitest';
import { parseSlackOAuthV2AccessResponse } from '../../../src/integrations/slack/oauth-v2-contracts.js';

const successfulResponse = {
  ok: true,
  access_token: 'xoxe.xoxb-access',
  token_type: 'bot',
  scope:
    'app_mentions:read,channels:history,channels:read,chat:write,commands,users:read',
  bot_user_id: 'U001',
  app_id: 'A001',
  team: { id: 'T001', name: 'Acme Engineering' },
  enterprise: null,
  authed_user: { id: 'U002' },
  refresh_token: 'xoxe-refresh',
  expires_in: 43_200,
};

describe('Slack OAuth V2 response contract', () => {
  it('accepts the required rotating bot installation response', () => {
    expect(parseSlackOAuthV2AccessResponse(successfulResponse)).toMatchObject({
      ok: true,
      team: { id: 'T001' },
      token_type: 'bot',
    });
  });

  it('accepts a bounded provider error without requiring credential fields', () => {
    expect(
      parseSlackOAuthV2AccessResponse({
        ok: false,
        error: 'invalid_code',
      }),
    ).toEqual({ ok: false, error: 'invalid_code' });
  });

  it('rejects non-bot, malformed, and incomplete rotation responses', () => {
    expect(() =>
      parseSlackOAuthV2AccessResponse({
        ...successfulResponse,
        token_type: 'user',
      }),
    ).toThrow();
    expect(() =>
      parseSlackOAuthV2AccessResponse({
        ...successfulResponse,
        team: { id: 'invalid', name: 'Acme Engineering' },
      }),
    ).toThrow();
    const missingExpiry = { ...successfulResponse, expires_in: undefined };
    expect(() => parseSlackOAuthV2AccessResponse(missingExpiry)).toThrow();
  });
});
