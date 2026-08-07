import {
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import {
  slackInstallationCredentialSchema,
  slackInstallationSecretArnSchema,
  type SlackInstallationCredential,
} from '../../application/onboarding/slack-installation.js';
import {
  SlackInstallationCredentialLifecycleError,
  type SlackInstallationCredentialLifecycle,
} from '../../application/ports/slack-installation-credential-lifecycle.js';

const recoveryWindowSchema = z.number().int().min(7).max(30);

/** Reads and schedules recoverable deletion of one installation credential. */
export class SecretsManagerSlackInstallationCredentialLifecycle implements SlackInstallationCredentialLifecycle {
  private readonly recoveryWindowDays: number;

  public constructor(
    private readonly client: SecretsManagerClient,
    options: { readonly recoveryWindowDays: number },
  ) {
    this.recoveryWindowDays = recoveryWindowSchema.parse(
      options.recoveryWindowDays,
    );
  }

  public async load(
    rawSecretArn: string,
  ): Promise<SlackInstallationCredential | null> {
    const secretArn = slackInstallationSecretArnSchema.parse(rawSecretArn);
    try {
      const response = await this.client.send(
        new GetSecretValueCommand({ SecretId: secretArn }),
      );
      const value =
        response.SecretString ??
        (response.SecretBinary === undefined
          ? undefined
          : Buffer.from(response.SecretBinary).toString('utf8'));
      if (value === undefined || value.length === 0) {
        throw new SlackInstallationCredentialLifecycleError(false);
      }
      return slackInstallationCredentialSchema.parse(
        JSON.parse(value) as unknown,
      );
    } catch (error) {
      if (error instanceof SlackInstallationCredentialLifecycleError) {
        throw error;
      }
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new SlackInstallationCredentialLifecycleError(false);
      }
      if (isNamedError(error, 'ResourceNotFoundException')) {
        return null;
      }
      if (
        isNamedError(error, 'InvalidRequestException') &&
        (await this.isScheduledForDeletion(secretArn))
      ) {
        return null;
      }
      throw new SlackInstallationCredentialLifecycleError(
        isRetryableSecretsManagerError(error),
      );
    }
  }

  public async scheduleDeletion(rawSecretArn: string): Promise<void> {
    const secretArn = slackInstallationSecretArnSchema.parse(rawSecretArn);
    try {
      await this.client.send(
        new DeleteSecretCommand({
          SecretId: secretArn,
          RecoveryWindowInDays: this.recoveryWindowDays,
        }),
      );
    } catch (error) {
      if (isNamedError(error, 'ResourceNotFoundException')) {
        return;
      }
      if (
        isNamedError(error, 'InvalidRequestException') &&
        (await this.isScheduledForDeletion(secretArn))
      ) {
        return;
      }
      throw new SlackInstallationCredentialLifecycleError(
        isRetryableSecretsManagerError(error),
      );
    }
  }

  private async isScheduledForDeletion(secretArn: string): Promise<boolean> {
    try {
      const described = await this.client.send(
        new DescribeSecretCommand({ SecretId: secretArn }),
      );
      return described.DeletedDate instanceof Date;
    } catch (error) {
      if (isNamedError(error, 'ResourceNotFoundException')) {
        return true;
      }
      throw new SlackInstallationCredentialLifecycleError(
        isRetryableSecretsManagerError(error),
      );
    }
  }
}

function isNamedError(error: unknown, name: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === name
  );
}

function isRetryableSecretsManagerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return true;
  }
  return [
    'InternalServiceError',
    'RequestTimeout',
    'ServiceUnavailable',
    'ThrottlingException',
    'TimeoutError',
  ].includes(String(error.name));
}
