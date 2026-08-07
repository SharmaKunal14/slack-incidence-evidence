// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackConnectionPage } from '../../web/src/app.js';
import type { Configuration } from '../../web/src/contracts.js';
import {
  consumeSlackOnboardingCallbackResult,
  requestSlackAuthorization,
} from '../../web/src/slack-onboarding.js';

const configuration: Configuration = {
  apiBaseUrl: 'https://review.example.test',
  cognitoBaseUrl: 'https://review.auth.example.test',
  cognitoClientId: 'client-id',
  redirectUri: 'https://review.example.test/',
};

beforeEach(() => {
  sessionStorage.clear();
  history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Slack onboarding console', () => {
  it('shows connected workspace metadata without credential material', async () => {
    const apiClient = vi.fn().mockResolvedValue({
      canStartInstallation: true,
      workspaces: [
        {
          workspaceId: 'T001',
          displayName: 'Acme Engineering',
          role: 'ADMIN',
          connectionStatus: 'CONNECTED',
          canManage: true,
          installedAt: '2026-08-05T01:00:00.000Z',
          updatedAt: '2026-08-05T01:05:00.000Z',
          credentialExpiresAt: null,
        },
      ],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SlackConnectionPage, {
          apiClient,
          configuration,
          token: 'access-token',
        }),
      ),
    );

    expect(
      await screen.findByRole('heading', { name: 'Acme Engineering' }),
    ).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add workspace' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Disconnect workspace' }),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('access-token');
    expect(document.body.textContent).not.toContain('credential_secret_arn');
    expect(apiClient).toHaveBeenCalledWith(
      configuration,
      'access-token',
      '/review/onboarding/slack/status',
    );
  });

  it('does not offer another workspace to a reviewer', async () => {
    const apiClient = vi.fn().mockResolvedValue({
      canStartInstallation: false,
      workspaces: [
        {
          workspaceId: 'T001',
          displayName: 'Acme Engineering',
          role: 'REVIEWER',
          connectionStatus: 'CONNECTED',
          canManage: false,
          installedAt: '2026-08-05T01:00:00.000Z',
          updatedAt: '2026-08-05T01:05:00.000Z',
          credentialExpiresAt: null,
        },
      ],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SlackConnectionPage, {
          apiClient,
          configuration,
          token: 'access-token',
        }),
      ),
    );

    expect(
      await screen.findByRole('heading', { name: 'Acme Engineering' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add workspace' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Disconnect workspace' }),
    ).toBeNull();
  });

  it('requires confirmation and sends only the workspace identifier', async () => {
    const statusResponse = {
      canStartInstallation: true,
      workspaces: [
        {
          workspaceId: 'T001',
          displayName: 'Acme Engineering',
          role: 'ADMIN',
          connectionStatus: 'CONNECTED',
          canManage: true,
          installedAt: '2026-08-05T01:00:00.000Z',
          updatedAt: '2026-08-05T01:05:00.000Z',
          credentialExpiresAt: null,
        },
      ],
    };
    const apiClient = vi
      .fn()
      .mockImplementation((_configuration, _token, path: string) =>
        path.endsWith('/disconnect')
          ? Promise.resolve({
              workspaceId: 'T001',
              status: 'DISCONNECTED',
              idempotent: false,
            })
          : Promise.resolve(statusResponse),
      );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SlackConnectionPage, {
          apiClient,
          configuration,
          token: 'access-token',
        }),
      ),
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'Disconnect workspace' }),
    );
    let dialog = screen.getByRole('alertdialog', {
      name: 'Disconnect this workspace?',
    });
    expect(dialog).toBeTruthy();
    expect(
      screen.getByText(/Slack will remove the OnRecord app/u),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Disconnect workspace' }),
    );
    dialog = screen.getByRole('alertdialog', {
      name: 'Disconnect this workspace?',
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Disconnect workspace' }),
    );

    await waitFor(() =>
      expect(apiClient).toHaveBeenCalledWith(
        configuration,
        'access-token',
        '/onboarding/slack/T001/disconnect',
        {
          method: 'POST',
          body: JSON.stringify({ confirmation: 'T001' }),
        },
      ),
    );
  });

  it('requests onboarding same-origin and accepts only Slack authorization URLs', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          authorizationUrl:
            'https://slack.com/oauth/v2/authorize?client_id=123&state=safe',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', request);

    await expect(
      requestSlackAuthorization(configuration, 'access-token'),
    ).resolves.toContain('https://slack.com/oauth/v2/authorize');
    expect(request).toHaveBeenCalledWith(
      new URL('/onboarding/slack/start', configuration.apiBaseUrl),
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
      }),
    );
  });

  it('rejects an untrusted authorization redirect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            authorizationUrl: 'https://attacker.example/oauth/v2/authorize',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        ),
      ),
    );

    await expect(
      requestSlackAuthorization(configuration, 'access-token'),
    ).rejects.toThrow('not trusted');
  });

  it('consumes the fixed callback result and routes to integrations', () => {
    history.replaceState({}, '', '/?slack=connected');

    expect(consumeSlackOnboardingCallbackResult()).toBe('connected');
    expect(location.search).toBe('');
    expect(location.hash).toBe('#/settings/integrations');
  });
});
