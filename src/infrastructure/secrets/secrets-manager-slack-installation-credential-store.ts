import {
  CreateSecretCommand,
  PutSecretValueCommand,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import {
  slackInstallationCredentialSchema,
  slackInstallationSecretArnSchema,
} from '../../application/onboarding/slack-installation.js';
import {
  SlackInstallationCredentialStoreError,
  type SlackInstallationCredentialStore,
} from '../../application/ports/slack-installation-credential-store.js';

const secretNamePrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9/_+=.@-]+$/u)
  .refine((value) => !value.endsWith('/'));
const kmsKeyIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .regex(/^[\x21-\x7e]+$/u);
const authorizationIdSchema = z.uuid();

/** Creates one attempt-scoped, KMS-encrypted secret with idempotent recovery. */
export class SecretsManagerSlackInstallationCredentialStore implements SlackInstallationCredentialStore {
  private readonly secretNamePrefix: string;
  private readonly kmsKeyId: string;

  public constructor(
    private readonly client: SecretsManagerClient,
    configuration: {
      readonly secretNamePrefix: string;
      readonly kmsKeyId: string;
    },
  ) {
    this.secretNamePrefix = secretNamePrefixSchema.parse(
      configuration.secretNamePrefix,
    );
    this.kmsKeyId = kmsKeyIdSchema.parse(configuration.kmsKeyId);
  }

  public async store(input: {
    readonly authorizationId: string;
    readonly credential: z.input<typeof slackInstallationCredentialSchema>;
  }): Promise<{ readonly secretArn: string }> {
    const authorizationId = authorizationIdSchema.parse(input.authorizationId);
    const credential = slackInstallationCredentialSchema.parse(
      input.credential,
    );
    const secretName = `${this.secretNamePrefix}/${authorizationId}`;
    const secretString = JSON.stringify(credential);

    try {
      const created = await this.client.send(
        new CreateSecretCommand({
          Name: secretName,
          Description: 'OnRecord tenant-scoped Slack installation credential',
          KmsKeyId: this.kmsKeyId,
          ClientRequestToken: authorizationId,
          SecretString: secretString,
          Tags: [
            { Key: 'onrecord:managed-by', Value: 'onboarding' },
            { Key: 'onrecord:credential-type', Value: 'slack-installation' },
          ],
        }),
      );
      return { secretArn: requireSecretArn(created.ARN) };
    } catch (error) {
      if (!isResourceExists(error)) {
        throw new SlackInstallationCredentialStoreError(
          isRetryableSecretsManagerError(error),
        );
      }
    }

    try {
      const recovered = await this.client.send(
        new PutSecretValueCommand({
          SecretId: secretName,
          ClientRequestToken: authorizationId,
          SecretString: secretString,
          VersionStages: ['AWSCURRENT'],
        }),
      );
      return { secretArn: requireSecretArn(recovered.ARN) };
    } catch (error) {
      throw new SlackInstallationCredentialStoreError(
        isRetryableSecretsManagerError(error),
      );
    }
  }
}

function requireSecretArn(value: string | undefined): string {
  const parsed = slackInstallationSecretArnSchema.safeParse(value);
  if (!parsed.success) {
    throw new SlackInstallationCredentialStoreError(false);
  }
  return parsed.data;
}

function isResourceExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'ResourceExistsException'
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
