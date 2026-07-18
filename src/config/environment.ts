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

const lambdaPostgresBaseEnvironmentSchema = commonEnvironmentSchema.extend({
  DATABASE_SECRET_ARN: z.string().trim().min(1),
  DATABASE_HOST: z.string().trim().min(1),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  DATABASE_NAME: z.string().trim().min(1),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(10).default(2),
});

const lambdaPostgresEnvironmentSchema =
  lambdaPostgresBaseEnvironmentSchema.extend({
    SLACK_BOT_TOKEN_SECRET_ARN: z.string().trim().min(1),
  });

const incidentWorkerLambdaEnvironmentSchema =
  lambdaPostgresEnvironmentSchema.extend({
    INCIDENT_WORKFLOW_STATE_MACHINE_ARN: z.string().trim().min(1),
  });

const incidentReviewNotificationLambdaEnvironmentSchema =
  lambdaPostgresEnvironmentSchema;

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

const incidentAnalysisLambdaEnvironmentSchema =
  lambdaPostgresBaseEnvironmentSchema
    .extend({
      OPENAI_API_SECRET_ARN: z.string().trim().min(1),
      OPENAI_MODEL: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
      ANALYSIS_MAX_ARTIFACTS: z.coerce
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100),
      ANALYSIS_MAX_INPUT_CHARACTERS: z.coerce
        .number()
        .int()
        .min(1_000)
        .max(1_000_000)
        .default(100_000),
      ANALYSIS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
      ANALYSIS_LEASE_SECONDS: z.coerce
        .number()
        .int()
        .min(30)
        .max(900)
        .default(180),
      OPENAI_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(1_000)
        .max(300_000)
        .default(90_000),
      OPENAI_MAX_OUTPUT_TOKENS: z.coerce
        .number()
        .int()
        .min(256)
        .max(32_768)
        .default(6_000),
    })
    .refine(
      (value) => value.ANALYSIS_LEASE_SECONDS * 1_000 > value.OPENAI_TIMEOUT_MS,
      {
        message: 'Analysis lease must outlive the OpenAI request timeout',
        path: ['ANALYSIS_LEASE_SECONDS'],
      },
    );

const incidentReportLambdaEnvironmentSchema =
  lambdaPostgresBaseEnvironmentSchema
    .extend({
      OPENAI_API_SECRET_ARN: z.string().trim().min(1),
      OPENAI_MODEL: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
      REPORT_MAX_SOURCES: z.coerce.number().int().min(1).max(500).default(200),
      REPORT_MAX_INPUT_CHARACTERS: z.coerce
        .number()
        .int()
        .min(1_000)
        .max(1_000_000)
        .default(100_000),
      REPORT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
      REPORT_LEASE_SECONDS: z.coerce
        .number()
        .int()
        .min(30)
        .max(900)
        .default(180),
      OPENAI_REPORT_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(1_000)
        .max(300_000)
        .default(90_000),
      OPENAI_REPORT_MAX_OUTPUT_TOKENS: z.coerce
        .number()
        .int()
        .min(256)
        .max(32_768)
        .default(8_000),
    })
    .refine(
      (value) =>
        value.REPORT_LEASE_SECONDS * 1_000 > value.OPENAI_REPORT_TIMEOUT_MS,
      {
        message: 'Report lease must outlive the OpenAI request timeout',
        path: ['REPORT_LEASE_SECONDS'],
      },
    );

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;
export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;
export type SlackIngressLambdaEnvironment = z.infer<
  typeof slackIngressLambdaEnvironmentSchema
>;
export type IncidentWorkerLambdaEnvironment = z.infer<
  typeof incidentWorkerLambdaEnvironmentSchema
>;
export type IncidentReviewNotificationLambdaEnvironment = z.infer<
  typeof incidentReviewNotificationLambdaEnvironmentSchema
>;
export type SlackEvidenceCollectorLambdaEnvironment = z.infer<
  typeof slackEvidenceCollectorLambdaEnvironmentSchema
>;
export type IncidentAnalysisLambdaEnvironment = z.infer<
  typeof incidentAnalysisLambdaEnvironmentSchema
>;
export type IncidentReportLambdaEnvironment = z.infer<
  typeof incidentReportLambdaEnvironmentSchema
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

export function loadIncidentReviewNotificationLambdaEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): IncidentReviewNotificationLambdaEnvironment {
  return incidentReviewNotificationLambdaEnvironmentSchema.parse(source);
}

export function loadSlackEvidenceCollectorLambdaEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): SlackEvidenceCollectorLambdaEnvironment {
  return slackEvidenceCollectorLambdaEnvironmentSchema.parse(source);
}

export function loadIncidentAnalysisLambdaEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): IncidentAnalysisLambdaEnvironment {
  return incidentAnalysisLambdaEnvironmentSchema.parse(source);
}

export function loadIncidentReportLambdaEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): IncidentReportLambdaEnvironment {
  return incidentReportLambdaEnvironmentSchema.parse(source);
}
