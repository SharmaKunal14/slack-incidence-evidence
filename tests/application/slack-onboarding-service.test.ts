import { createHash } from 'node:crypto';
import { describe, expect, it, vi, type MockedFunction } from 'vitest';
import {
  SlackOnboardingError,
  SlackOnboardingService,
} from '../../src/application/onboarding/slack-onboarding-service.js';
import { SLACK_REQUIRED_BOT_SCOPES } from '../../src/application/onboarding/slack-installation.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { IdGenerator } from '../../src/application/ports/id-generator.js';
import type { SlackInstallationCredentialStore } from '../../src/application/ports/slack-installation-credential-store.js';
import type { SlackOAuthProvider } from '../../src/application/ports/slack-oauth-provider.js';
import {
  SlackOnboardingRepositoryError,
  type SlackOnboardingRepository,
} from '../../src/application/ports/slack-onboarding-repository.js';
import type { SecureTokenGenerator } from '../../src/application/ports/secure-token-generator.js';

const authorizationId = 'b5ce083c-6f22-4c8d-87fc-d23a8d2aa92c';
const installationUuid = 'a64196b3-d68a-4fd3-aaea-8c65a599bf78';
const state = 's'.repeat(43);
const browserBinding = 'b'.repeat(43);
const now = new Date('2026-08-05T01:00:00.000Z');
const secretArn =
  'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:onrecord/slack/installations/attempt-AbCd12';

const grant = {
  appId: 'A001',
  teamId: 'T001',
  teamName: 'Acme Engineering',
  enterpriseId: null,
  botUserId: 'U001',
  authedUserId: 'W002',
  accessToken: 'xoxe.xoxb-access',
  refreshToken: 'xoxe-refresh',
  expiresInSeconds: 43_200,
  grantedScopes: [...SLACK_REQUIRED_BOT_SCOPES].reverse(),
  isEnterpriseInstall: false,
} as const;

interface TestDependencies {
  readonly service: SlackOnboardingService;
  readonly createAuthorization: MockedFunction<
    SlackOnboardingRepository['createAuthorization']
  >;
  readonly consumeAuthorization: MockedFunction<
    SlackOnboardingRepository['consumeAuthorization']
  >;
  readonly failAuthorization: MockedFunction<
    SlackOnboardingRepository['failAuthorization']
  >;
  readonly completeInstallation: MockedFunction<
    SlackOnboardingRepository['completeInstallation']
  >;
  readonly exchangeCode: MockedFunction<SlackOAuthProvider['exchangeCode']>;
  readonly verifyBot: MockedFunction<SlackOAuthProvider['verifyBot']>;
  readonly storeCredential: MockedFunction<
    SlackInstallationCredentialStore['store']
  >;
}

function dependencies(
  overrides: {
    readonly repository?: Partial<SlackOnboardingRepository>;
    readonly provider?: Partial<SlackOAuthProvider>;
    readonly credentialStore?: Partial<SlackInstallationCredentialStore>;
    readonly generatedIds?: readonly string[];
    readonly tokens?: readonly string[];
  } = {},
): TestDependencies {
  const createAuthorization = vi
    .fn<SlackOnboardingRepository['createAuthorization']>()
    .mockResolvedValue(undefined);
  const consumeAuthorization = vi
    .fn<SlackOnboardingRepository['consumeAuthorization']>()
    .mockResolvedValue({
      status: 'CONSUMED',
      id: authorizationId,
      cognitoSubject: 'cognito-user-1',
      redirectUri: 'https://app.example.com/onboarding/slack/callback',
      requestedScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      createdAt: now,
      expiresAt: new Date('2026-08-05T01:10:00.000Z'),
      consumedAt: now,
    });
  const failAuthorization = vi
    .fn<SlackOnboardingRepository['failAuthorization']>()
    .mockResolvedValue(undefined);
  const completeInstallation = vi
    .fn<SlackOnboardingRepository['completeInstallation']>()
    .mockResolvedValue({
      installationId: 'slack-installation:existing',
      tenantId: 'T001',
      kind: 'CREATED',
      idempotent: false,
    });
  if (overrides.repository?.createAuthorization !== undefined) {
    createAuthorization.mockImplementation(
      overrides.repository.createAuthorization,
    );
  }
  if (overrides.repository?.consumeAuthorization !== undefined) {
    consumeAuthorization.mockImplementation(
      overrides.repository.consumeAuthorization,
    );
  }
  if (overrides.repository?.failAuthorization !== undefined) {
    failAuthorization.mockImplementation(
      overrides.repository.failAuthorization,
    );
  }
  if (overrides.repository?.completeInstallation !== undefined) {
    completeInstallation.mockImplementation(
      overrides.repository.completeInstallation,
    );
  }
  const repository: SlackOnboardingRepository = {
    createAuthorization,
    consumeAuthorization,
    failAuthorization,
    completeInstallation,
  };
  const exchangeCode = vi
    .fn<SlackOAuthProvider['exchangeCode']>()
    .mockResolvedValue(grant);
  const verifyBot = vi
    .fn<SlackOAuthProvider['verifyBot']>()
    .mockResolvedValue({ teamId: 'T001', userId: 'U001' });
  if (overrides.provider?.exchangeCode !== undefined) {
    exchangeCode.mockImplementation(overrides.provider.exchangeCode);
  }
  if (overrides.provider?.verifyBot !== undefined) {
    verifyBot.mockImplementation(overrides.provider.verifyBot);
  }
  const provider: SlackOAuthProvider = { exchangeCode, verifyBot };
  const storeCredential = vi
    .fn<SlackInstallationCredentialStore['store']>()
    .mockResolvedValue({ secretArn });
  if (overrides.credentialStore?.store !== undefined) {
    storeCredential.mockImplementation(overrides.credentialStore.store);
  }
  const credentialStore: SlackInstallationCredentialStore = {
    store: storeCredential,
  };
  const ids = [
    ...(overrides.generatedIds ?? [authorizationId, installationUuid]),
  ];
  const idGenerator = {
    generate: vi.fn(() => ids.shift() ?? installationUuid),
  } satisfies IdGenerator;
  const tokens = [...(overrides.tokens ?? [state, browserBinding])];
  const tokenGenerator = {
    generate: vi.fn(() => tokens.shift() ?? state),
  } satisfies SecureTokenGenerator;
  const clock = { now: vi.fn(() => new Date(now)) } satisfies Clock;
  const service = new SlackOnboardingService(
    repository,
    provider,
    credentialStore,
    tokenGenerator,
    idGenerator,
    clock,
    {
      clientId: '123.456',
      expectedAppId: 'A001',
      redirectUri: 'https://app.example.com/onboarding/slack/callback',
    },
  );
  return {
    service,
    createAuthorization,
    consumeAuthorization,
    failAuthorization,
    completeInstallation,
    exchangeCode,
    verifyBot,
    storeCredential,
  };
}

describe('SlackOnboardingService', () => {
  it('starts with independent high-entropy values and persists only their hashes', async () => {
    const { service, createAuthorization } = dependencies();

    const started = await service.start('cognito-user-1');
    const authorizationUrl = new URL(started.authorizationUrl);

    expect(authorizationUrl.origin).toBe('https://slack.com');
    expect(authorizationUrl.pathname).toBe('/oauth/v2/authorize');
    expect(authorizationUrl.searchParams.get('state')).toBe(state);
    expect(authorizationUrl.searchParams.get('scope')).toBe(
      SLACK_REQUIRED_BOT_SCOPES.join(','),
    );
    expect(started.browserBinding).toBe(browserBinding);
    expect(createAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        id: authorizationId,
        stateSha256: createHash('sha256').update(state).digest('hex'),
        browserBindingSha256: createHash('sha256')
          .update(browserBinding)
          .digest('hex'),
      }),
    );
    expect(createAuthorization).not.toHaveBeenCalledWith(
      expect.objectContaining({ state }),
    );
  });

  it('validates Slack identity, stores the credential, and persists only its ARN', async () => {
    const {
      service,
      exchangeCode,
      verifyBot,
      storeCredential,
      completeInstallation,
    } = dependencies({
      generatedIds: [installationUuid],
    });

    await expect(
      service.complete({
        state,
        browserBinding,
        code: 'temporary-code',
      }),
    ).resolves.toMatchObject({ tenantId: 'T001', kind: 'CREATED' });

    expect(exchangeCode).toHaveBeenCalledWith({
      code: 'temporary-code',
      redirectUri: 'https://app.example.com/onboarding/slack/callback',
    });
    expect(verifyBot).toHaveBeenCalledWith(grant.accessToken);
    const storedCredential = storeCredential.mock.calls[0]?.[0];
    expect(storedCredential?.authorizationId).toBe(authorizationId);
    expect(storedCredential?.credential).toMatchObject({
      teamId: 'T001',
      accessToken: grant.accessToken,
      rotation: {
        mode: 'ROTATING',
        refreshToken: grant.refreshToken,
      },
    });
    expect(completeInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: `slack-installation:${installationUuid}`,
        credentialSecretArn: secretArn,
        grantedScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      }),
    );
    expect(completeInstallation).not.toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: grant.accessToken }),
    );
  });

  it('returns an already completed callback without repeating external effects', async () => {
    const completion = {
      installationId: 'slack-installation:existing',
      tenantId: 'T001',
      kind: 'CREATED' as const,
      idempotent: true,
    };
    const { service, exchangeCode, storeCredential } = dependencies({
      repository: {
        consumeAuthorization: vi.fn().mockResolvedValue({
          status: 'COMPLETED',
          id: authorizationId,
          completion,
        }),
      },
    });

    await expect(
      service.complete({
        state,
        browserBinding,
        code: 'already-used-code',
      }),
    ).resolves.toEqual(completion);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(storeCredential).not.toHaveBeenCalled();
  });

  it('fails closed on invalid state without calling Slack', async () => {
    const { service, failAuthorization, exchangeCode } = dependencies({
      repository: { consumeAuthorization: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      service.complete({
        state,
        browserBinding,
        code: 'temporary-code',
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(failAuthorization).not.toHaveBeenCalled();
  });

  it('converts malformed callback input to a content-safe state error', async () => {
    const { service, consumeAuthorization } = dependencies();

    await expect(
      service.complete({
        state: 'not valid state',
        browserBinding,
        code: 'temporary-code',
      }),
    ).rejects.toEqual(new SlackOnboardingError('OAUTH_STATE_INVALID', false));
    expect(consumeAuthorization).not.toHaveBeenCalled();
  });

  it('records a safe failure when Slack returns the wrong scope set', async () => {
    const { service, failAuthorization, verifyBot, storeCredential } =
      dependencies({
        provider: {
          exchangeCode: vi.fn().mockResolvedValue({
            ...grant,
            grantedScopes: SLACK_REQUIRED_BOT_SCOPES.slice(0, -1),
          }),
        },
      });

    await expect(
      service.complete({
        state,
        browserBinding,
        code: 'temporary-code',
      }),
    ).rejects.toMatchObject({ code: 'SLACK_SCOPES_MISMATCH' });
    expect(failAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: 'SLACK_SCOPES_MISMATCH' }),
    );
    expect(verifyBot).not.toHaveBeenCalled();
    expect(storeCredential).not.toHaveBeenCalled();
  });

  it('does not expose an existing tenant when installation requires an admin', async () => {
    const { service, failAuthorization, storeCredential } = dependencies({
      generatedIds: [installationUuid],
      repository: {
        completeInstallation: vi
          .fn()
          .mockRejectedValue(
            new SlackOnboardingRepositoryError(
              'ADMIN_REQUIRED',
              'internal detail',
            ),
          ),
      },
    });

    await expect(
      service.complete({
        state,
        browserBinding,
        code: 'temporary-code',
      }),
    ).rejects.toEqual(
      new SlackOnboardingError('SLACK_INSTALLATION_ADMIN_REQUIRED', false),
    );
    expect(storeCredential).toHaveBeenCalledOnce();
    expect(failAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: 'SLACK_INSTALLATION_ADMIN_REQUIRED',
      }),
    );
  });

  it('rejects an invalid credential-store reference before database completion', async () => {
    const { service, completeInstallation, failAuthorization } = dependencies({
      generatedIds: [installationUuid],
      credentialStore: {
        store: vi.fn().mockResolvedValue({ secretArn: 'not-an-arn' }),
      },
    });

    await expect(
      service.complete({
        state,
        browserBinding,
        code: 'temporary-code',
      }),
    ).rejects.toMatchObject({ code: 'SLACK_CREDENTIAL_STORAGE_FAILED' });
    expect(completeInstallation).not.toHaveBeenCalled();
    expect(failAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: 'SLACK_CREDENTIAL_STORAGE_FAILED',
      }),
    );
  });
});
