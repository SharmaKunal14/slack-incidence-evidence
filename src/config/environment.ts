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
});

const queueEnvironmentSchema = commonEnvironmentSchema.extend({
  INCIDENT_QUEUE_URL: z.url(),
});

const apiEnvironmentSchema = queueEnvironmentSchema.extend({
  API_HOST: z.string().trim().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SLACK_SIGNING_SECRET: z.string().min(1),
});

const workerEnvironmentSchema = queueEnvironmentSchema.extend({
  DATABASE_URL: z.string().trim().min(1),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
});

const slackIngressLambdaEnvironmentSchema = queueEnvironmentSchema.extend({
  SLACK_SIGNING_SECRET_ARN: z.string().trim().min(1),
});

const lambdaPostgresEnvironmentSchema = commonEnvironmentSchema.extend({
  DATABASE_SECRET_ARN: z.string().trim().min(1),
  DATABASE_HOST: z.string().trim().min(1),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  DATABASE_NAME: z.string().trim().min(1),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(10).default(2),
  SLACK_BOT_TOKEN_SECRET_ARN: z.string().trim().min(1),
});

const incidentWorkerLambdaEnvironmentSchema =
  lambdaPostgresEnvironmentSchema.extend({
    INCIDENT_WORKFLOW_STATE_MACHINE_ARN: z.string().trim().min(1),
  });

const slackEvidenceCollectorLambdaEnvironmentSchema =
  lambdaPostgresEnvironmentSchema.extend({
    EVIDENCE_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30),
    SLACK_THREAD_MAX_PAGES: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(100),
  });

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;
export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;
export type SlackIngressLambdaEnvironment = z.infer<
  typeof slackIngressLambdaEnvironmentSchema
>;
export type IncidentWorkerLambdaEnvironment = z.infer<
  typeof incidentWorkerLambdaEnvironmentSchema
>;
export type SlackEvidenceCollectorLambdaEnvironment = z.infer<
  typeof slackEvidenceCollectorLambdaEnvironmentSchema
>;

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

export function loadSlackIngressLambdaEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): SlackIngressLambdaEnvironment {
  return slackIngressLambdaEnvironmentSchema.parse(source);
}

export function loadIncidentWorkerLambdaEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): IncidentWorkerLambdaEnvironment {
  return incidentWorkerLambdaEnvironmentSchema.parse(source);
}

export function loadSlackEvidenceCollectorLambdaEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): SlackEvidenceCollectorLambdaEnvironment {
  return slackEvidenceCollectorLambdaEnvironmentSchema.parse(source);
}
