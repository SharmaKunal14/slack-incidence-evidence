// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeSlackIdentityCallbackResult,
  requestSlackIdentityAuthorization,
} from '../../web/src/workspace-access.js';

const configuration = {
  apiBaseUrl: 'https://app.example.test',
  cognitoBaseUrl: 'https://auth.example.test',
  cognitoClientId: 'client-id',
  redirectUri: 'https://app.example.test/',
};
const invitationToken = 'i'.repeat(43);

afterEach(() => {
  sessionStorage.clear();
  history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('Slack invitation callback navigation', () => {
  it('returns a failed identity callback to the original invitation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            authorizationUrl:
              'https://slack.com/openid/connect/authorize?state=safe',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
          { status: 200 },
        ),
      ),
    );
    await requestSlackIdentityAuthorization(
      configuration,
      'access-token',
      invitationToken,
    );
    history.replaceState({}, '', '/?slack_identity=failed');

    expect(consumeSlackIdentityCallbackResult()).toBe('failed');
    expect(location.hash).toBe(`#/invitations/${invitationToken}`);
    expect(location.search).toBe('');
  });

  it('does not restore an untrusted invitation value', () => {
    sessionStorage.setItem('onrecord_pending_invitation', '../unsafe');
    history.replaceState({}, '', '/?slack_identity=failed');

    expect(consumeSlackIdentityCallbackResult()).toBe('failed');
    expect(location.hash).toBe('#/settings/integrations');
  });
});
