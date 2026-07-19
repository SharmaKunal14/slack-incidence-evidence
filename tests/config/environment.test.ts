import { describe, expect, it } from 'vitest';
import {
  loadApprovedReportPublicationLambdaEnvironment,
  loadIncidentAnalysisLambdaEnvironment,
  loadIncidentReviewApiLambdaEnvironment,
  loadIncidentReviewNotificationLambdaEnvironment,
  loadIncidentReportLambdaEnvironment,
  loadLiveEvaluationEnvironment,
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

  it('loads independent bounded report-generation budgets', () => {
    const source = {
      DATABASE_SECRET_ARN: 'database-secret-arn',
      DATABASE_HOST: 'pooler.example.test',
      DATABASE_NAME: 'postgres',
      OPENAI_API_SECRET_ARN: 'openai-secret-arn',
      OPENAI_MODEL: 'approved-model-snapshot',
      REPORT_MAX_SOURCES: '150',
      REPORT_MAX_INPUT_CHARACTERS: '80000',
      REPORT_MAX_ATTEMPTS: '2',
      REPORT_LEASE_SECONDS: '180',
      OPENAI_REPORT_TIMEOUT_MS: '90000',
      OPENAI_REPORT_MAX_OUTPUT_TOKENS: '7000',
    };

    expect(loadIncidentReportLambdaEnvironment(source)).toMatchObject({
      REPORT_MAX_SOURCES: 150,
      REPORT_MAX_INPUT_CHARACTERS: 80000,
      REPORT_MAX_ATTEMPTS: 2,
      REPORT_LEASE_SECONDS: 180,
      OPENAI_REPORT_TIMEOUT_MS: 90000,
      OPENAI_REPORT_MAX_OUTPUT_TOKENS: 7000,
    });
    expect(() =>
      loadIncidentReportLambdaEnvironment({
        ...source,
        REPORT_LEASE_SECONDS: '60',
      }),
    ).toThrow();
  });

  it('loads bounded review API and plain HTTPS review-link configuration', () => {
    const database = {
      DATABASE_SECRET_ARN: 'database-secret-arn',
      DATABASE_HOST: 'pooler.example.test',
      DATABASE_NAME: 'postgres',
    };

    expect(
      loadIncidentReviewApiLambdaEnvironment({
        ...database,
        REVIEW_API_MAX_BODY_BYTES: '262144',
      }).REVIEW_API_MAX_BODY_BYTES,
    ).toBe(262_144);
    expect(() =>
      loadIncidentReviewApiLambdaEnvironment({
        ...database,
        REVIEW_API_MAX_BODY_BYTES: '1048577',
      }),
    ).toThrow();

    expect(
      loadIncidentReviewNotificationLambdaEnvironment({
        ...database,
        SLACK_BOT_TOKEN_SECRET_ARN: 'slack-bot-secret-arn',
        REVIEW_APP_BASE_URL: 'https://review.example.test',
      }).REVIEW_APP_BASE_URL,
    ).toBe('https://review.example.test');
    expect(() =>
      loadIncidentReviewNotificationLambdaEnvironment({
        ...database,
        SLACK_BOT_TOKEN_SECRET_ARN: 'slack-bot-secret-arn',
        REVIEW_APP_BASE_URL: 'https://user@review.example.test?secret=value',
      }),
    ).toThrow();
  });

  it('loads bounded Notion publication configuration without a plaintext token', () => {
    const source = {
      DATABASE_SECRET_ARN: 'database-secret-arn',
      DATABASE_HOST: 'pooler.example.test',
      DATABASE_NAME: 'postgres',
      SLACK_BOT_TOKEN_SECRET_ARN: 'slack-bot-secret-arn',
      NOTION_API_SECRET_ARN: 'notion-secret-arn',
      NOTION_DATA_SOURCE_ID: '0123456789abcdef0123456789abcdef',
      NOTION_TITLE_PROPERTY: 'Name',
      NOTION_INCIDENT_ID_PROPERTY: 'Incident ID',
      PUBLICATION_BATCH_SIZE: '2',
      PUBLICATION_MAX_ATTEMPTS: '8',
      PUBLICATION_LEASE_SECONDS: '180',
      PUBLICATION_RETRY_BASE_SECONDS: '60',
      NOTION_TIMEOUT_MS: '10000',
    };

    expect(
      loadApprovedReportPublicationLambdaEnvironment(source),
    ).toMatchObject({
      PUBLICATION_BATCH_SIZE: 2,
      PUBLICATION_MAX_ATTEMPTS: 8,
      PUBLICATION_LEASE_SECONDS: 180,
      NOTION_TIMEOUT_MS: 10_000,
    });
    expect(
      loadApprovedReportPublicationLambdaEnvironment(source),
    ).not.toHaveProperty('NOTION_API_TOKEN');
    expect(() =>
      loadApprovedReportPublicationLambdaEnvironment({
        ...source,
        NOTION_INCIDENT_ID_PROPERTY: 'Name',
      }),
    ).toThrow();
    expect(() =>
      loadApprovedReportPublicationLambdaEnvironment({
        ...source,
        PUBLICATION_BATCH_SIZE: '11',
      }),
    ).toThrow();
  });

  it('loads live evaluation configuration without a plaintext API key', () => {
    const environment = loadLiveEvaluationEnvironment({
      EVAL_ALLOW_LIVE_PROVIDER: 'true',
      AWS_REGION: 'ap-southeast-2',
      OPENAI_API_SECRET_ARN:
        'arn:aws:secretsmanager:ap-southeast-2:393209814365:secret:incident-copilot/development/openai-AbCdEf',
      OPENAI_MODEL: 'approved-model-snapshot',
    });

    expect(environment).toMatchObject({
      EVAL_ALLOW_LIVE_PROVIDER: 'true',
      AWS_REGION: 'ap-southeast-2',
      OPENAI_MODEL: 'approved-model-snapshot',
      OPENAI_TIMEOUT_MS: 90_000,
      OPENAI_MAX_OUTPUT_TOKENS: 6_000,
      OPENAI_REPORT_MAX_OUTPUT_TOKENS: 8_000,
    });
    expect(environment).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('requires explicit live-evaluation consent and a Secrets Manager ARN', () => {
    const source = {
      AWS_REGION: 'ap-southeast-2',
      OPENAI_API_SECRET_ARN:
        'arn:aws:secretsmanager:ap-southeast-2:393209814365:secret:incident-copilot/development/openai-AbCdEf',
      OPENAI_MODEL: 'approved-model-snapshot',
    };

    expect(() => loadLiveEvaluationEnvironment(source)).toThrow();
    expect(() =>
      loadLiveEvaluationEnvironment({
        ...source,
        EVAL_ALLOW_LIVE_PROVIDER: 'true',
        OPENAI_API_SECRET_ARN: 'not-a-secrets-manager-arn',
        OPENAI_API_KEY: 'must-not-be-used',
      }),
    ).toThrow();
    expect(() =>
      loadLiveEvaluationEnvironment({
        ...source,
        EVAL_ALLOW_LIVE_PROVIDER: 'true',
        AWS_REGION: 'us-east-1',
      }),
    ).toThrow();
  });
});
