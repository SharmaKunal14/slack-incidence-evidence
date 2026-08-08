import type { z } from 'zod';
import type {
  completeSlackInstallationSchema,
  consumeSlackOAuthAuthorizationSchema,
  createSlackOAuthAuthorizationSchema,
  failSlackOAuthAuthorizationSchema,
} from '../onboarding/slack-installation.js';

export type CreateSlackOAuthAuthorizationInput = z.input<
  typeof createSlackOAuthAuthorizationSchema
>;
export type ConsumeSlackOAuthAuthorizationInput = z.input<
  typeof consumeSlackOAuthAuthorizationSchema
>;
export type CompleteSlackInstallationInput = z.input<
  typeof completeSlackInstallationSchema
>;
export type FailSlackOAuthAuthorizationInput = z.input<
  typeof failSlackOAuthAuthorizationSchema
>;

export interface ConsumedSlackOAuthAuthorization {
  readonly status: 'CONSUMED';
  readonly id: string;
  readonly cognitoSubject: string;
  readonly redirectUri: string;
  readonly requestedScopes: readonly string[];
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date;
}

export interface CompletedSlackOAuthAuthorization {
  readonly status: 'COMPLETED';
  readonly id: string;
  readonly completion: SlackInstallationCompletion;
}

export type ClaimedSlackOAuthAuthorization =
  ConsumedSlackOAuthAuthorization | CompletedSlackOAuthAuthorization;

export interface SlackInstallationCompletion {
  readonly installationId: string;
  readonly tenantId: string;
  readonly kind: 'CREATED' | 'REINSTALLED';
  readonly idempotent: boolean;
}

export class SlackOnboardingRepositoryError extends Error {
  public constructor(
    readonly code:
      'AUTHORIZATION_NOT_USABLE' | 'ADMIN_REQUIRED' | 'IDENTITY_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'SlackOnboardingRepositoryError';
  }
}

export interface SlackOnboardingRepository {
  requiresWorkspaceAdministrator(teamId: string): Promise<boolean>;
  createAuthorization(input: CreateSlackOAuthAuthorizationInput): Promise<void>;
  consumeAuthorization(
    input: ConsumeSlackOAuthAuthorizationInput,
  ): Promise<ClaimedSlackOAuthAuthorization | null>;
  failAuthorization(input: FailSlackOAuthAuthorizationInput): Promise<void>;
  completeInstallation(
    input: CompleteSlackInstallationInput,
  ): Promise<SlackInstallationCompletion>;
}
