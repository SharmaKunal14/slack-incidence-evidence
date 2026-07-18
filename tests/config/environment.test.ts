import { describe, expect, it } from 'vitest';
import {
  loadIncidentAnalysisLambdaEnvironment,
  loadIncidentWorkerLambdaEnvironment,
  loadSlackEvidenceCollectorLambdaEnvironment,
  loadSlackIngressLambdaEnvironment,
} from '../../src/config/environment.js';

describe('Lambda environment configuration', () => {
  it('loads the ingress boundary without requiring a plaintext secret', () => {
    const environment = loadSlackIngressLambdaEnvironment({
      INCIDENT_QUEUE_URL: 'https://sqs.example.test/queue.fifo',
      SLACK_SIGNING_SECRET_ARN:
        'arn:aws:secretsmanager:region:account:secret:slack',
    });

    expect(environment).toMatchObject({
      AWS_REGION: 'ap-southeast-2',
      INCIDENT_QUEUE_URL: 'https://sqs.example.test/queue.fifo',
      SLACK_SIGNING_SECRET_ARN:
        'arn:aws:secretsmanager:region:account:secret:slack',
    });
    expect(environment).not.toHaveProperty('SLACK_SIGNING_SECRET');
  });

  it('loads bounded evidence retention configuration', () => {
    const environment = loadSlackEvidenceCollectorLambdaEnvironment({
      DATABASE_SECRET_ARN: 'database-secret-arn',
      DATABASE_HOST: 'pooler.example.test',
      DATABASE_NAME: 'postgres',
      SLACK_BOT_TOKEN_SECRET_ARN: 'slack-bot-secret-arn',
      EVIDENCE_RETENTION_DAYS: '45',
      SLACK_THREAD_MAX_PAGES: '25',
    });

    expect(environment.EVIDENCE_RETENTION_DAYS).toBe(45);
    expect(environment.SLACK_THREAD_MAX_PAGES).toBe(25);
    expect(() =>
      loadSlackEvidenceCollectorLambdaEnvironment({
        DATABASE_SECRET_ARN: 'database-secret-arn',
        DATABASE_HOST: 'pooler.example.test',
        DATABASE_NAME: 'postgres',
        SLACK_BOT_TOKEN_SECRET_ARN: 'slack-bot-secret-arn',
        EVIDENCE_RETENTION_DAYS: '366',
      }),
    ).toThrow();
    expect(() =>
      loadSlackEvidenceCollectorLambdaEnvironment({
        DATABASE_SECRET_ARN: 'database-secret-arn',
        DATABASE_HOST: 'pooler.example.test',
        DATABASE_NAME: 'postgres',
        SLACK_BOT_TOKEN_SECRET_ARN: 'slack-bot-secret-arn',
        SLACK_THREAD_MAX_PAGES: '1001',
      }),
    ).toThrow();
  });

  it('loads bounded worker database and workflow settings', () => {
    const environment = loadIncidentWorkerLambdaEnvironment({
      DATABASE_SECRET_ARN: 'database-secret-arn',
      DATABASE_HOST: 'proxy.internal.example',
      DATABASE_PORT: '5433',
      DATABASE_NAME: 'incident_copilot',
      DATABASE_SSL: 'false',
      DATABASE_POOL_MAX: '3',
      INCIDENT_WORKFLOW_STATE_MACHINE_ARN: 'state-machine-arn',
      SLACK_BOT_TOKEN_SECRET_ARN: 'slack-bot-secret-arn',
    });

    expect(environment).toMatchObject({
      DATABASE_HOST: 'proxy.internal.example',
      DATABASE_PORT: 5433,
      DATABASE_SSL: false,
      DATABASE_POOL_MAX: 3,
    });
  });

  it('enables database TLS by default and rejects an unbounded pool', () => {
    const source = {
      DATABASE_SECRET_ARN: 'database-secret-arn',
      DATABASE_HOST: 'proxy.internal.example',
      DATABASE_NAME: 'incident_copilot',
      INCIDENT_WORKFLOW_STATE_MACHINE_ARN: 'state-machine-arn',
      SLACK_BOT_TOKEN_SECRET_ARN: 'slack-bot-secret-arn',
    };

    expect(loadIncidentWorkerLambdaEnvironment(source).DATABASE_SSL).toBe(true);
    expect(() =>
      loadIncidentWorkerLambdaEnvironment({
        ...source,
        DATABASE_POOL_MAX: '11',
      }),
    ).toThrow();
  });

  it('loads bounded analysis budgets and requires an explicit model', () => {
    const source = {
      DATABASE_SECRET_ARN: 'database-secret-arn',
      DATABASE_HOST: 'pooler.example.test',
      DATABASE_NAME: 'postgres',
      OPENAI_API_SECRET_ARN: 'openai-secret-arn',
      OPENAI_MODEL: 'approved-model-snapshot',
      ANALYSIS_MAX_ARTIFACTS: '75',
      ANALYSIS_MAX_INPUT_CHARACTERS: '90000',
      ANALYSIS_MAX_ATTEMPTS: '2',
      ANALYSIS_LEASE_SECONDS: '180',
      OPENAI_TIMEOUT_MS: '90000',
      OPENAI_MAX_OUTPUT_TOKENS: '5000',
    };

    expect(loadIncidentAnalysisLambdaEnvironment(source)).toMatchObject({
      OPENAI_MODEL: 'approved-model-snapshot',
      ANALYSIS_MAX_ARTIFACTS: 75,
      ANALYSIS_MAX_INPUT_CHARACTERS: 90000,
      ANALYSIS_MAX_ATTEMPTS: 2,
      ANALYSIS_LEASE_SECONDS: 180,
      OPENAI_TIMEOUT_MS: 90000,
      OPENAI_MAX_OUTPUT_TOKENS: 5000,
    });
    expect(() =>
      loadIncidentAnalysisLambdaEnvironment({
        ...source,
        OPENAI_MODEL: '',
      }),
    ).toThrow();
    expect(() =>
      loadIncidentAnalysisLambdaEnvironment({
        ...source,
        ANALYSIS_LEASE_SECONDS: '60',
      }),
    ).toThrow();
  });
});
