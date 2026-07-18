import { z } from 'zod';

const slackSigningSecretSchema = z
  .object({
    signingSecret: z.string().min(1),
  })
  .strict();

const slackBotTokenSecretSchema = z
  .object({
    workspaceId: z.string().regex(/^T[A-Z0-9]{1,63}$/),
    botToken: z.string().min(1).max(4096),
  })
  .strict();

const certificateBundleSchema = z
  .string()
  .trim()
  .regex(
    /^(?:-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?)+$/,
  );

const databaseConnectionSecretSchema = z
  .object({
    username: z.string().trim().min(1),
    password: z.string().min(1),
    caCertificate: certificateBundleSchema,
  })
  .strict();

const openAiApiSecretSchema = z
  .object({
    apiKey: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[!-~]+$/),
  })
  .strict();

export interface SlackSigningSecret {
  readonly signingSecret: string;
}

export interface SlackBotTokenSecret {
  readonly workspaceId: string;
  readonly botToken: string;
}

export interface DatabaseConnectionSecret {
  readonly username: string;
  readonly password: string;
  readonly caCertificate: string;
}

export interface OpenAiApiSecret {
  readonly apiKey: string;
}

export function parseSlackSigningSecret(value: string): SlackSigningSecret {
  try {
    return slackSigningSecretSchema.parse(parseJson(value));
  } catch {
    throw new InvalidRuntimeSecretError();
  }
}

export function parseSlackBotTokenSecret(value: string): SlackBotTokenSecret {
  try {
    return slackBotTokenSecretSchema.parse(parseJson(value));
  } catch {
    throw new InvalidRuntimeSecretError();
  }
}

export function parseDatabaseConnectionSecret(
  value: string,
): DatabaseConnectionSecret {
  try {
    return databaseConnectionSecretSchema.parse(parseJson(value));
  } catch {
    throw new InvalidRuntimeSecretError();
  }
}

export function parseOpenAiApiSecret(value: string): OpenAiApiSecret {
  try {
    return openAiApiSecretSchema.parse(parseJson(value));
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
