import {
  GetSecretValueCommand,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

export class SecretValueUnavailableError extends Error {
  public constructor() {
    super('Secrets Manager returned no usable secret value');
    this.name = 'SecretValueUnavailableError';
  }
}

/**
 * Small, content-safe Secrets Manager adapter for Lambda composition roots.
 * Successful reads are cached for the lifetime of a warm execution environment;
 * failed reads are evicted so a transient AWS error can recover on retry.
 */
export class SecretsManagerSecretReader {
  private readonly cachedReads = new Map<string, Promise<string>>();

  public constructor(private readonly client: SecretsManagerClient) {}

  public async readString(secretId: string): Promise<string> {
    const normalizedSecretId = secretId.trim();
    if (normalizedSecretId.length === 0) {
      throw new Error('Secret ID must not be empty');
    }

    const cached = this.cachedReads.get(normalizedSecretId);
    if (cached !== undefined) {
      return cached;
    }

    const pending = this.fetchString(normalizedSecretId);
    this.cachedReads.set(normalizedSecretId, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.cachedReads.get(normalizedSecretId) === pending) {
        this.cachedReads.delete(normalizedSecretId);
      }
      throw error;
    }
  }

  public evict(secretId: string): void {
    this.cachedReads.delete(secretId.trim());
  }

  private async fetchString(secretId: string): Promise<string> {
    const result = await this.client.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    const value =
      result.SecretString ??
      (result.SecretBinary === undefined
        ? undefined
        : Buffer.from(result.SecretBinary).toString('utf8'));

    if (value === undefined || value.length === 0) {
      throw new SecretValueUnavailableError();
    }
    return value;
  }
}
