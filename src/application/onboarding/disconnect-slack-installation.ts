import { z } from 'zod';
import { cognitoSubjectSchema } from '../identity/cognito-subject.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import {
  SlackInstallationCredentialLifecycleError,
  type SlackInstallationCredentialLifecycle,
} from '../ports/slack-installation-credential-lifecycle.js';
import {
  SlackInstallationDisconnectionRepositoryError,
  type SlackInstallationDisconnectClaim,
  type SlackInstallationDisconnectionRepository,
} from '../ports/slack-installation-disconnection-repository.js';
import {
  SlackAppUninstallError,
  type SlackAppUninstaller,
  type SlackAppUninstallOutcome,
} from '../ports/slack-app-uninstaller.js';

const disconnectInputSchema = z
  .object({
    workspaceId: z.string().regex(/^T[A-Z0-9]{1,63}$/u),
    cognitoSubject: cognitoSubjectSchema,
    requestId: z.string().trim().min(1).max(256),
  })
  .strict();

export type SlackInstallationDisconnectionErrorCode =
  | 'SLACK_INSTALLATION_ADMIN_REQUIRED'
  | 'SLACK_INSTALLATION_DISCONNECT_CONFLICT'
  | 'SLACK_INSTALLATION_DISCONNECT_PERSISTENCE_FAILED'
  | 'SLACK_INSTALLATION_CREDENTIAL_INVALID'
  | 'SLACK_INSTALLATION_CREDENTIAL_ACCESS_FAILED'
  | 'SLACK_APP_UNINSTALL_FAILED'
  | 'SLACK_CREDENTIAL_DELETION_FAILED';

export class SlackInstallationDisconnectionError extends Error {
  public constructor(
    readonly code: SlackInstallationDisconnectionErrorCode,
    readonly retryable: boolean,
  ) {
    super('Slack installation could not be disconnected');
    this.name = 'SlackInstallationDisconnectionError';
  }
}

export interface SlackInstallationDisconnectionResult {
  readonly workspaceId: string;
  readonly status: 'DISCONNECTED';
  readonly idempotent: boolean;
}

/** Fail-closed, retryable orchestration for one tenant Slack installation. */
export class DisconnectSlackInstallation {
  public constructor(
    private readonly repository: SlackInstallationDisconnectionRepository,
    private readonly credentials: SlackInstallationCredentialLifecycle,
    private readonly appUninstaller: SlackAppUninstaller,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  public async execute(
    rawInput: z.input<typeof disconnectInputSchema>,
  ): Promise<SlackInstallationDisconnectionResult> {
    const input = disconnectInputSchema.parse(rawInput);
    const startedAt = validDate(this.clock.now());
    let claim: SlackInstallationDisconnectClaim;
    try {
      claim = await this.repository.begin({
        ...input,
        auditEventId: z.uuid().parse(this.idGenerator.generate()),
        occurredAt: startedAt,
      });
    } catch (error) {
      throw normalizeRepositoryError(error);
    }

    if (
      claim.state === 'ALREADY_DISCONNECTED' &&
      claim.credentialSecretArn === null
    ) {
      return {
        workspaceId: claim.workspaceId,
        status: 'DISCONNECTED',
        idempotent: true,
      };
    }

    try {
      const cleanup = await this.uninstallAndScheduleCredentialDeletion(claim);
      const completed = await this.repository.complete({
        claim,
        cognitoSubject: input.cognitoSubject,
        auditEventId: z.uuid().parse(this.idGenerator.generate()),
        requestId: input.requestId,
        slackUninstallOutcome: cleanup.uninstallOutcome,
        secretDeletionScheduled: cleanup.secretDeletionScheduled,
        occurredAt: validDate(this.clock.now()),
      });
      return {
        workspaceId: claim.workspaceId,
        status: 'DISCONNECTED',
        idempotent: claim.state !== 'CLAIMED' || completed.idempotent,
      };
    } catch (error) {
      const safeError = normalizeExternalError(error);
      try {
        await this.repository.recordFailure({
          claim,
          cognitoSubject: input.cognitoSubject,
          auditEventId: z.uuid().parse(this.idGenerator.generate()),
          requestId: input.requestId,
          failureCode: safeError.code,
          retryable: safeError.retryable,
          occurredAt: validDate(this.clock.now()),
        });
      } catch {
        throw new SlackInstallationDisconnectionError(
          'SLACK_INSTALLATION_DISCONNECT_PERSISTENCE_FAILED',
          true,
        );
      }
      throw safeError;
    }
  }

  private async uninstallAndScheduleCredentialDeletion(
    claim: SlackInstallationDisconnectClaim,
  ): Promise<{
    readonly uninstallOutcome:
      SlackAppUninstallOutcome | 'CREDENTIAL_UNAVAILABLE';
    readonly secretDeletionScheduled: boolean;
  }> {
    if (claim.credentialSecretArn === null) {
      return {
        uninstallOutcome: 'CREDENTIAL_UNAVAILABLE',
        secretDeletionScheduled: false,
      };
    }
    let credential;
    try {
      credential = await this.credentials.load(claim.credentialSecretArn);
    } catch (error) {
      throw new SlackInstallationDisconnectionError(
        'SLACK_INSTALLATION_CREDENTIAL_ACCESS_FAILED',
        error instanceof SlackInstallationCredentialLifecycleError
          ? error.retryable
          : true,
      );
    }
    if (credential === null) {
      return {
        uninstallOutcome: 'CREDENTIAL_UNAVAILABLE',
        secretDeletionScheduled: false,
      };
    }
    if (credential.teamId !== claim.workspaceId) {
      throw new SlackInstallationDisconnectionError(
        'SLACK_INSTALLATION_CREDENTIAL_INVALID',
        false,
      );
    }
    const uninstallOutcome = await this.appUninstaller.uninstall(
      credential.accessToken,
    );
    try {
      await this.credentials.scheduleDeletion(claim.credentialSecretArn);
    } catch (error) {
      throw new SlackInstallationDisconnectionError(
        'SLACK_CREDENTIAL_DELETION_FAILED',
        error instanceof SlackInstallationCredentialLifecycleError
          ? error.retryable
          : true,
      );
    }
    return { uninstallOutcome, secretDeletionScheduled: true };
  }
}

function normalizeRepositoryError(
  error: unknown,
): SlackInstallationDisconnectionError {
  if (error instanceof SlackInstallationDisconnectionRepositoryError) {
    return new SlackInstallationDisconnectionError(
      error.code === 'ADMIN_REQUIRED'
        ? 'SLACK_INSTALLATION_ADMIN_REQUIRED'
        : 'SLACK_INSTALLATION_DISCONNECT_CONFLICT',
      false,
    );
  }
  return new SlackInstallationDisconnectionError(
    'SLACK_INSTALLATION_DISCONNECT_PERSISTENCE_FAILED',
    true,
  );
}

function normalizeExternalError(
  error: unknown,
): SlackInstallationDisconnectionError {
  if (error instanceof SlackInstallationDisconnectionError) {
    return error;
  }
  if (error instanceof SlackAppUninstallError) {
    return new SlackInstallationDisconnectionError(
      'SLACK_APP_UNINSTALL_FAILED',
      error.retryable,
    );
  }
  return new SlackInstallationDisconnectionError(
    'SLACK_INSTALLATION_DISCONNECT_PERSISTENCE_FAILED',
    true,
  );
}

function validDate(value: Date): Date {
  if (Number.isNaN(value.getTime())) {
    throw new SlackInstallationDisconnectionError(
      'SLACK_INSTALLATION_DISCONNECT_PERSISTENCE_FAILED',
      false,
    );
  }
  return value;
}
