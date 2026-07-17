import { describe, expect, it } from 'vitest';
import {
  loadIncidentWorkerLambdaEnvironment,
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
});
