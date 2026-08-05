import { describe, expect, it } from 'vitest';
import {
  SLACK_INSTALLATION_STATUSES,
  SLACK_OAUTH_AUTHORIZATION_TTL_SECONDS,
  SLACK_REQUIRED_BOT_SCOPES,
  isSlackInstallationCredentialCurrent,
  isSlackInstallationTransitionAllowed,
  slackInstallationCredentialSchema,
} from '../../src/application/onboarding/slack-installation.js';

describe('Slack onboarding contracts', () => {
  it('owns the required least-privilege bot scopes and authorization lifetime', () => {
    expect(SLACK_REQUIRED_BOT_SCOPES).toEqual([
      'app_mentions:read',
      'channels:history',
      'channels:read',
      'chat:write',
      'commands',
      'users:read',
    ]);
    expect(SLACK_OAUTH_AUTHORIZATION_TTL_SECONDS).toBe(600);
  });

  it('accepts long-lived and internally consistent rotating credentials', () => {
    expect(
      slackInstallationCredentialSchema.parse({
        schemaVersion: 1,
        teamId: 'T001',
        botUserId: 'U001',
        accessToken: 'xoxb-long-lived',
        rotation: { mode: 'LONG_LIVED' },
      }),
    ).toMatchObject({ teamId: 'T001' });

    expect(
      slackInstallationCredentialSchema.parse({
        schemaVersion: 1,
        teamId: 'T001',
        botUserId: 'U001',
        accessToken: 'xoxe.xoxb-access',
        rotation: {
          mode: 'ROTATING',
          refreshToken: 'xoxe-refresh',
          expiresAt: '2026-08-05T12:00:00.000Z',
        },
      }),
    ).toMatchObject({ rotation: { mode: 'ROTATING' } });
  });

  it('rejects malformed, incomplete, or unexpectedly extended credentials', () => {
    expect(() =>
      slackInstallationCredentialSchema.parse({
        schemaVersion: 1,
        teamId: 'wrong',
        botUserId: 'U001',
        accessToken: 'xoxb-value',
        rotation: { mode: 'LONG_LIVED' },
      }),
    ).toThrow();

    expect(() =>
      slackInstallationCredentialSchema.parse({
        schemaVersion: 1,
        teamId: 'T001',
        botUserId: 'U001',
        accessToken: 'xoxe-access',
        rotation: { mode: 'ROTATING', refreshToken: 'xoxe-refresh' },
      }),
    ).toThrow();

    expect(() =>
      slackInstallationCredentialSchema.parse({
        schemaVersion: 1,
        teamId: 'T001',
        botUserId: 'U001',
        accessToken: 'xoxb-value',
        rotation: { mode: 'LONG_LIVED' },
        signingSecret: 'wrong-boundary',
      }),
    ).toThrow();
  });

  it('defines the fail-closed installation lifecycle', () => {
    expect(SLACK_INSTALLATION_STATUSES).toEqual([
      'PENDING',
      'ACTIVE',
      'RECONNECT_REQUIRED',
      'REVOKED',
      'FAILED',
    ]);
    expect(isSlackInstallationTransitionAllowed('PENDING', 'ACTIVE')).toBe(
      true,
    );
    expect(
      isSlackInstallationTransitionAllowed('ACTIVE', 'RECONNECT_REQUIRED'),
    ).toBe(true);
    expect(isSlackInstallationTransitionAllowed('REVOKED', 'PENDING')).toBe(
      true,
    );
    expect(isSlackInstallationTransitionAllowed('REVOKED', 'ACTIVE')).toBe(
      false,
    );
    expect(isSlackInstallationTransitionAllowed('ACTIVE', 'PENDING')).toBe(
      false,
    );
  });

  it('treats expired or invalid-time credentials as unusable', () => {
    const credential = slackInstallationCredentialSchema.parse({
      schemaVersion: 1,
      teamId: 'T001',
      botUserId: 'U001',
      accessToken: 'xoxe.xoxb-access',
      rotation: {
        mode: 'ROTATING',
        refreshToken: 'xoxe-refresh',
        expiresAt: '2026-08-05T12:00:00.000Z',
      },
    });

    expect(
      isSlackInstallationCredentialCurrent(
        credential,
        new Date('2026-08-05T11:59:59.000Z'),
      ),
    ).toBe(true);
    expect(
      isSlackInstallationCredentialCurrent(
        credential,
        new Date('2026-08-05T12:00:00.000Z'),
      ),
    ).toBe(false);
    expect(
      isSlackInstallationCredentialCurrent(credential, new Date('invalid')),
    ).toBe(false);
  });
});
