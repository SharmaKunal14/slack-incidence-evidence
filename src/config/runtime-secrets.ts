import { z } from 'zod';

const slackSigningSecretSchema = z
  .object({
    signingSecret: z.string().min(1),
  })
  .strict();

const databaseCredentialsSchema = z
  .object({
    username: z.string().trim().min(1),
    password: z.string().min(1),
  })
  .strict();

export interface SlackSigningSecret {
  readonly signingSecret: string;
}

export interface DatabaseCredentials {
  readonly username: string;
  readonly password: string;
}

export function parseSlackSigningSecret(value: string): SlackSigningSecret {
  try {
    return slackSigningSecretSchema.parse(parseJson(value));
  } catch {
    throw new InvalidRuntimeSecretError();
  }
}

export function parseDatabaseCredentials(value: string): DatabaseCredentials {
  try {
    return databaseCredentialsSchema.parse(parseJson(value));
  } catch {
    throw new InvalidRuntimeSecretError();
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // Do not echo a malformed secret into an exception or log.
    throw new InvalidRuntimeSecretError();
  }
}

export class InvalidRuntimeSecretError extends Error {
  public constructor() {
    super('Runtime secret does not match the required JSON contract');
    this.name = 'InvalidRuntimeSecretError';
  }
}
