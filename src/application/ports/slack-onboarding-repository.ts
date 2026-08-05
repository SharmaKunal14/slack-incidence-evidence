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
  readonly id: string;
  readonly cognitoSubject: string;
  readonly redirectUri: string;
  readonly requestedScopes: readonly string[];
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date;
}

export interface SlackInstallationCompletion {
  readonly installationId: string;
  readonly tenantId: string;
  readonly kind: 'CREATED' | 'REINSTALLED';
  readonly idempotent: boolean;
}

export interface SlackOnboardingRepository {
  createAuthorization(input: CreateSlackOAuthAuthorizationInput): Promise<void>;
  consumeAuthorization(
    input: ConsumeSlackOAuthAuthorizationInput,
  ): Promise<ConsumedSlackOAuthAuthorization | null>;
  failAuthorization(input: FailSlackOAuthAuthorizationInput): Promise<void>;
  completeInstallation(
    input: CompleteSlackInstallationInput,
  ): Promise<SlackInstallationCompletion>;
}
