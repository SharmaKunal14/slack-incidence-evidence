import { z } from 'zod';

const commonEnvironmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  AWS_REGION: z.string().trim().min(1).default('ap-southeast-2'),
  AWS_ENDPOINT_URL: z.url().optional(),
  INCIDENT_QUEUE_URL: z.url(),
});

const apiEnvironmentSchema = commonEnvironmentSchema.extend({
  API_HOST: z.string().trim().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SLACK_SIGNING_SECRET: z.string().min(1),
});

const workerEnvironmentSchema = commonEnvironmentSchema.extend({
  DATABASE_URL: z.string().trim().min(1),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
});

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;
export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;

export function loadApiEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): ApiEnvironment {
  return apiEnvironmentSchema.parse(source);
}

export function loadWorkerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): WorkerEnvironment {
  return workerEnvironmentSchema.parse(source);
}
