import { describe, expect, it } from 'vitest';
import {
  SLACK_INSTALLATION_STATUSES,
  SLACK_OAUTH_AUTHORIZATION_TTL_SECONDS,
  SLACK_REQUIRED_BOT_SCOPES,
  completeSlackInstallationSchema,
  consumeSlackOAuthAuthorizationSchema,
  createSlackOAuthAuthorizationSchema,
  isSlackInstallationCredentialCurrent,
  isSlackInstallationTransitionAllowed,
  slackInstallationCredentialSchema,
} from '../../src/application/onboarding/slack-installation.js';

const stateSha256 = 'a'.repeat(64);
const browserBindingSha256 = 'b'.repeat(64);
const createdAt = new Date('2026-08-05T01:00:00.000Z');

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

    expect(
      slackInstallationCredentialSchema.parse({
        schemaVersion: 1,
        teamId: 'T001',
        botUserId: 'W001',
        accessToken: 'xoxb-grid',
        rotation: { mode: 'LONG_LIVED' },
      }),
    ).toMatchObject({ botUserId: 'W001' });
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

  it('requires bounded, HTTPS, browser-bound OAuth authorization metadata', () => {
    expect(
      createSlackOAuthAuthorizationSchema.parse({
        id: 'b5ce083c-6f22-4c8d-87fc-d23a8d2aa92c',
        stateSha256,
        browserBindingSha256,
        cognitoSubject: 'cognito-user-1',
        redirectUri: 'https://app.example.com/onboarding/slack/callback',
        requestedScopes: [...SLACK_REQUIRED_BOT_SCOPES],
        createdAt,
        expiresAt: new Date('2026-08-05T01:10:00.000Z'),
      }),
    ).toMatchObject({ stateSha256, browserBindingSha256 });

    expect(() =>
      createSlackOAuthAuthorizationSchema.parse({
        id: 'b5ce083c-6f22-4c8d-87fc-d23a8d2aa92c',
        stateSha256,
        browserBindingSha256,
        cognitoSubject: 'cognito-user-1',
        redirectUri: 'http://app.example.com/onboarding/slack/callback',
        requestedScopes: [...SLACK_REQUIRED_BOT_SCOPES],
        createdAt,
        expiresAt: createdAt,
      }),
    ).toThrow();
    expect(() =>
      createSlackOAuthAuthorizationSchema.parse({
        id: 'b5ce083c-6f22-4c8d-87fc-d23a8d2aa92c',
        stateSha256,
        browserBindingSha256,
        cognitoSubject: 'cognito-user-1',
        redirectUri: 'https://app.example.com/onboarding/slack/callback',
        requestedScopes: [...SLACK_REQUIRED_BOT_SCOPES],
        createdAt,
        expiresAt: new Date('2026-08-05T01:10:01.000Z'),
      }),
    ).toThrow();
  });

  it('requires exact scopes and a Secrets Manager reference for completion', () => {
    const validCompletion = {
      authorizationId: 'b5ce083c-6f22-4c8d-87fc-d23a8d2aa92c',
      installationId: 'installation:T001',
      cognitoSubject: 'cognito-user-1',
      teamId: 'T001',
      teamName: 'Acme Engineering',
      enterpriseId: null,
      appId: 'A001',
      botUserId: 'U001',
      authedSlackUserId: 'U002',
      credentialSecretArn:
        'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:onrecord/slack/T001-AbCd12',
      credentialExpiresAt: new Date('2026-08-05T13:00:00.000Z'),
      grantedScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      completedAt: new Date('2026-08-05T01:01:00.000Z'),
    };
    expect(
      completeSlackInstallationSchema.parse(validCompletion),
    ).toMatchObject({ teamId: 'T001' });
    expect(() =>
      completeSlackInstallationSchema.parse({
        ...validCompletion,
        grantedScopes: SLACK_REQUIRED_BOT_SCOPES.slice(0, -1),
      }),
    ).toThrow();
    expect(() =>
      completeSlackInstallationSchema.parse({
        ...validCompletion,
        credentialSecretArn: 'xoxb-secret-must-not-be-stored-here',
      }),
    ).toThrow();
    expect(() =>
      completeSlackInstallationSchema.parse({
        ...validCompletion,
        accessToken: 'xoxb-secret-must-not-cross-this-boundary',
      }),
    ).toThrow();
  });

  it('requires all state-consumption bindings', () => {
    expect(() =>
      consumeSlackOAuthAuthorizationSchema.parse({
        stateSha256,
        cognitoSubject: 'cognito-user-1',
        consumedAt: createdAt,
      }),
    ).toThrow();
  });
});
