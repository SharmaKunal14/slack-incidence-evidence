import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackInstallationCredentialResolutionError } from '../../../src/application/ports/slack-installation-credential-resolver.js';
import {
  ResolvingSlackChannelSource,
  ResolvingSlackIncidentScopeModal,
  ResolvingSlackIncidentStatusNotifier,
} from '../../../src/integrations/slack/resolving-slack-adapters.js';

const incidentId = '2c6a2f4a-f762-41e9-9620-a07abdaa5c48';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workspace-resolving Slack adapters', () => {
  it('uses the credential resolved for the notification workspace', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          channel: 'C001',
          ts: '1721178001.000200',
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', request);
    const resolve = vi.fn().mockResolvedValue({
      workspaceId: 'T001',
      botToken: 'xoxb-workspace-one',
    });

    await new ResolvingSlackIncidentStatusNotifier({ resolve }).notifyAccepted({
      workspaceId: 'T001',
      incidentId,
      channelId: 'C001',
      threadTs: '1721178000.000100',
    });

    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith('T001');
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer xoxb-workspace-one',
    });
    if (typeof init?.body !== 'string') {
      throw new Error('Expected Slack request body to be JSON text');
    }
    expect(init.body).not.toContain('xoxb-workspace-one');
  });

  it('fails modal opening with a safe mapped resolver error', async () => {
    const modal = new ResolvingSlackIncidentScopeModal({
      resolve: vi
        .fn()
        .mockRejectedValue(
          new SlackInstallationCredentialResolutionError(
            'SLACK_INSTALLATION_NOT_FOUND',
            false,
          ),
        ),
    });

    await expect(
      modal.open({
        triggerId: 'trigger',
        workspaceId: 'T404',
        userId: 'U001',
        channelId: 'C001',
        messageTs: '1721178000.000100',
        defaultStartedAt: new Date('2026-08-07T00:00:00.000Z'),
        defaultEndedAt: new Date('2026-08-07T01:00:00.000Z'),
        evidenceRetentionDays: 30,
      }),
    ).rejects.toMatchObject({
      code: 'SLACK_INSTALLATION_NOT_FOUND',
      retryable: false,
    });
  });

  it('marks inactive workspace credentials as revoked during collection', async () => {
    const source = new ResolvingSlackChannelSource({
      resolve: vi
        .fn()
        .mockRejectedValue(
          new SlackInstallationCredentialResolutionError(
            'SLACK_INSTALLATION_NOT_ACTIVE',
            false,
          ),
        ),
    });

    await expect(
      source.fetchPage({
        workspaceId: 'T001',
        channelId: 'C001',
        phase: 'CHANNEL',
        oldest: new Date('2026-08-07T00:00:00.000Z'),
        latest: new Date('2026-08-07T01:00:00.000Z'),
        includeDisplayName: false,
      }),
    ).rejects.toMatchObject({
      code: 'SLACK_INSTALLATION_NOT_ACTIVE',
      retryable: false,
      terminalStatus: 'REVOKED',
    });
  });
});
