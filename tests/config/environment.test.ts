import { describe, expect, it } from 'vitest';
import {
  loadDatabaseMigrationEnvironment,
  loadApprovedReportPublicationLambdaEnvironment,
  loadIncidentAnalysisLambdaEnvironment,
  loadIncidentReviewApiLambdaEnvironment,
  loadIncidentReviewNotificationLambdaEnvironment,
  loadIncidentReportLambdaEnvironment,
  loadLiveEvaluationEnvironment,
  loadIncidentWorkerLambdaEnvironment,
  loadSlackEvidenceCollectorLambdaEnvironment,
  loadSlackIngressLambdaEnvironment,
  loadSlackInstallationDisconnectLambdaEnvironment,
  loadSlackOnboardingCallbackLambdaEnvironment,
  loadSlackOnboardingStartLambdaEnvironment,
} from '../../src/config/environment.js';

describe('Lambda environment configuration', () => {
  it('separates public onboarding start configuration from callback secrets', () => {
    const database = {
      DATABASE_SECRET_ARN: 'database-secret-arn',
      DATABASE_HOST: 'pooler.example.test',
      DATABASE_NAME: 'postgres',
      SLACK_OAUTH_CLIENT_ID: '123.456',
      SLACK_OAUTH_REDIRECT_URI:
        'https://api.example.test/onboarding/slack/callback',
    };
    const start = loadSlackOnboardingStartLambdaEnvironment(database);
    expect(start).not.toHaveProperty('SLACK_OAUTH_APP_SECRET_ARN');

    const callback = loadSlackOnboardingCallbackLambdaEnvironment({
      ...database,
      SLACK_OAUTH_APP_ID: 'A001',
      SLACK_OAUTH_APP_SECRET_ARN: 'slack-oauth-secret-arn',
      SLACK_INSTALLATION_SECRET_PREFIX:
        'incident-copilot/development/slack/installations',
      SLACK_INSTALLATION_KMS_KEY_ARN: 'kms-key-arn',
      ONBOARDING_SUCCESS_REDIRECT_URL:
        'https://app.example.test/?slack=connected',
      ONBOARDING_FAILURE_REDIRECT_URL: 'https://app.example.test/?slack=failed',
    });
    expect(callback.SLACK_OAUTH_TIMEOUT_MS).toBe(5_000);
    expect(() =>
      loadSlackOnboardingStartLambdaEnvironment({
        ...database,
        SLACK_OAUTH_REDIRECT_URI: 'http://api.example.test/callback',
      }),
    ).toThrow();
  });

  it('loads bounded Slack disconnection cleanup configuration without an OAuth app secret', () => {
    const environment = loadSlackInstallationDisconnectLambdaEnvironment({
      DATABASE_SECRET_ARN: 'database-secret-arn',
      DATABASE_HOST: 'pooler.example.test',
      DATABASE_NAME: 'postgres',
      SLACK_CREDENTIAL_RECOVERY_WINDOW_DAYS: '7',
      SLACK_TOKEN_REVOCATION_TIMEOUT_MS: '5000',
    });

    expect(environment.SLACK_CREDENTIAL_RECOVERY_WINDOW_DAYS).toBe(7);
    expect(environment.SLACK_TOKEN_REVOCATION_TIMEOUT_MS).toBe(5_000);
    expect(environment).not.toHaveProperty('SLACK_OAUTH_APP_SECRET_ARN');
    expect(() =>
      loadSlackInstallationDisconnectLambdaEnvironment({
        DATABASE_SECRET_ARN: 'database-secret-arn',
        DATABASE_HOST: 'pooler.example.test',
        DATABASE_NAME: 'postgres',
        SLACK_CREDENTIAL_RECOVERY_WINDOW_DAYS: '0',
      }),
    ).toThrow();
  });

  it('loads an AWS-backed migration target without a connection string', () => {
    const environment = loadDatabaseMigrationEnvironment({
      AWS_REGION: 'ap-southeast-2',
      DATABASE_SECRET_ARN:
        'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:database-AbCdEf',
      DATABASE_HOST: 'aws-0-ap-southeast-2.pooler.supabase.com',
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'postgres',
    });

    expect(environment).toMatchObject({
      DATABASE_HOST: 'aws-0-ap-southeast-2.pooler.supabase.com',
      DATABASE_PORT: 5432,
      DATABASE_NAME: 'postgres',
      DATABASE_SSL: true,
    });
    expect(environment).not.toHaveProperty('DATABASE_URL');
    expect(() =>
      loadDatabaseMigrationEnvironment({
        AWS_REGION: 'us-east-1',
        DATABASE_SECRET_ARN:
          'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:database-AbCdEf',
        DATABASE_HOST: 'pooler.example.test',
        DATABASE_NAME: 'postgres',
      }),
    ).toThrow('Database secret ARN region must match AWS_REGION');
  });

  it('loads the ingress boundary without requiring a plaintext secret', () => {
    const environment = loadSlackIngressLambdaEnvironment({
      DATABASE_SECRET_ARN: 'database-secret-arn',
      DATABASE_HOST: 'pooler.example.test',
      DATABASE_NAME: 'postgres',
      INCIDENT_QUEUE_URL: 'https://sqs.example.test/queue.fifo',
      SLACK_SIGNING_SECRET_ARN:
        'arn:aws:secretsmanager:region:account:secret:slack',
    });

    expect(environment).toMatchObject({
      AWS_REGION: 'ap-southeast-2',
      DATABASE_SECRET_ARN: 'database-secret-arn',
      INCIDENT_QUEUE_URL: 'https://sqs.example.test/queue.fifo',
      SLACK_SIGNING_SECRET_ARN:
        'arn:aws:secretsmanager:region:account:secret:slack',
    });
    expect(environment).not.toHaveProperty('SLACK_SIGNING_SECRET');
    expect(environment).not.toHaveProperty('SLACK_BOT_TOKEN_SECRET_ARN');
  });

  it('loads bounded evidence retention configuration', () => {
    const environment = loadSlackEvidenceCollectorLambdaEnvironment({
      DATABASE_SECRET_ARN: 'database-secret-arn',
      DATABASE_HOST: 'pooler.example.test',
      DATABASE_NAME: 'postgres',
      EVIDENCE_RETENTION_DAYS: '45',
      SLACK_AUTO_THREAD_MAX_COUNT: '40',
      SLACK_THREAD_MAX_PAGES: '25',
    });

    expect(environment.EVIDENCE_RETENTION_DAYS).toBe(45);
    expect(environment.SLACK_AUTO_THREAD_MAX_COUNT).toBe(40);
    expect(environment.SLACK_THREAD_MAX_PAGES).toBe(25);
    expect(() =>
      loadSlackEvidenceCollectorLambdaEnvironment({
        DATABASE_SECRET_ARN: 'database-secret-arn',
        DATABASE_HOST: 'pooler.example.test',
        DATABASE_NAME: 'postgres',
        EVIDENCE_RETENTION_DAYS: '366',
      }),
    ).toThrow();
    expect(() =>
      loadSlackEvidenceCollectorLambdaEnvironment({
        DATABASE_SECRET_ARN: 'database-secret-arn',
        DATABASE_HOST: 'pooler.example.test',
        DATABASE_NAME: 'postgres',
        SLACK_AUTO_THREAD_MAX_COUNT: '501',
      }),
    ).toThrow();
    expect(() =>
      loadSlackEvidenceCollectorLambdaEnvironment({
        DATABASE_SECRET_ARN: 'database-secret-arn',
        DATABASE_HOST: 'pooler.example.test',
        DATABASE_NAME: 'postgres',
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
      PII_LANGUAGE_CODE: 'en',
      PII_MIN_CONFIDENCE: '0.9',
    };

    expect(loadIncidentAnalysisLambdaEnvironment(source)).toMatchObject({
      OPENAI_MODEL: 'approved-model-snapshot',
      ANALYSIS_MAX_ARTIFACTS: 75,
      ANALYSIS_MAX_INPUT_CHARACTERS: 90000,
      ANALYSIS_MAX_ATTEMPTS: 2,
      ANALYSIS_LEASE_SECONDS: 180,
      OPENAI_TIMEOUT_MS: 90000,
      OPENAI_MAX_OUTPUT_TOKENS: 5000,
      PII_LANGUAGE_CODE: 'en',
      PII_MIN_CONFIDENCE: 0.9,
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
        REVIEW_APP_BASE_URL: 'https://review.example.test',
      }).REVIEW_APP_BASE_URL,
    ).toBe('https://review.example.test');
    expect(() =>
      loadIncidentReviewNotificationLambdaEnvironment({
        ...database,
        REVIEW_APP_BASE_URL: 'https://user@review.example.test?secret=value',
      }),
    ).toThrow();
  });

  it('loads bounded Notion publication configuration without a plaintext token', () => {
    const source = {
      DATABASE_SECRET_ARN: 'database-secret-arn',
      DATABASE_HOST: 'pooler.example.test',
      DATABASE_NAME: 'postgres',
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
      REPORT_PUBLICATION_PROVIDER: 'NOTION',
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

  it('loads only the selected Confluence publication contract', () => {
    const source = {
      REPORT_PUBLICATION_PROVIDER: 'CONFLUENCE',
      DATABASE_SECRET_ARN: 'database-secret-arn',
      DATABASE_HOST: 'pooler.example.test',
      DATABASE_NAME: 'postgres',
      CONFLUENCE_API_SECRET_ARN: 'confluence-secret-arn',
      CONFLUENCE_BASE_URL: 'https://incident-copilot.atlassian.net',
      CONFLUENCE_CLOUD_ID: '11111111-2222-3333-4444-555555555555',
      CONFLUENCE_SPACE_ID: '123456789',
      CONFLUENCE_PARENT_PAGE_ID: '987654321',
      CONFLUENCE_TIMEOUT_MS: '12000',
    };

    expect(
      loadApprovedReportPublicationLambdaEnvironment(source),
    ).toMatchObject({
      REPORT_PUBLICATION_PROVIDER: 'CONFLUENCE',
      CONFLUENCE_BASE_URL: 'https://incident-copilot.atlassian.net',
      CONFLUENCE_CLOUD_ID: '11111111-2222-3333-4444-555555555555',
      CONFLUENCE_SPACE_ID: '123456789',
      CONFLUENCE_PARENT_PAGE_ID: '987654321',
      CONFLUENCE_TIMEOUT_MS: 12_000,
    });
    expect(
      loadApprovedReportPublicationLambdaEnvironment(source),
    ).not.toHaveProperty('NOTION_API_SECRET_ARN');
    expect(() =>
      loadApprovedReportPublicationLambdaEnvironment({
        ...source,
        CONFLUENCE_BASE_URL: 'https://internal.example.test',
      }),
    ).toThrow();
    expect(() =>
      loadApprovedReportPublicationLambdaEnvironment({
        ...source,
        CONFLUENCE_SPACE_ID: '../admin',
      }),
    ).toThrow();
    expect(() =>
      loadApprovedReportPublicationLambdaEnvironment({
        ...source,
        CONFLUENCE_CLOUD_ID: '../another-tenant',
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
