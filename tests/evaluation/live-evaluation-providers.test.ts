import { describe, expect, it, vi } from 'vitest';
import { InvalidRuntimeSecretError } from '../../src/config/runtime-secrets.js';
import {
  createLiveEvaluationProviders,
  type EvaluationSecretReader,
} from '../../src/evaluation/live-evaluation-providers.js';
import { ResponsesIncidentAnalyzer } from '../../src/integrations/openai/responses-incident-analyzer.js';
import { ResponsesIncidentReportGenerator } from '../../src/integrations/openai/responses-incident-report-generator.js';

const environment = {
  EVAL_ALLOW_LIVE_PROVIDER: 'true' as const,
  AWS_REGION: 'ap-southeast-2',
  OPENAI_API_SECRET_ARN:
    'arn:aws:secretsmanager:ap-southeast-2:393209814365:secret:incident-copilot/development/openai-AbCdEf',
  OPENAI_MODEL: 'approved-model-snapshot',
  OPENAI_TIMEOUT_MS: 90_000,
  OPENAI_MAX_OUTPUT_TOKENS: 6_000,
  OPENAI_REPORT_MAX_OUTPUT_TOKENS: 8_000,
};

describe('createLiveEvaluationProviders', () => {
  it('retrieves the exact secret ARN and constructs both provider adapters', async () => {
    const readString = vi
      .fn<EvaluationSecretReader['readString']>()
      .mockResolvedValue(JSON.stringify({ apiKey: 'synthetic-openai-key' }));

    const providers = await createLiveEvaluationProviders(environment, {
      readString,
    });

    expect(readString).toHaveBeenCalledWith(environment.OPENAI_API_SECRET_ARN);
    expect(providers.analyzer).toBeInstanceOf(ResponsesIncidentAnalyzer);
    expect(providers.generator).toBeInstanceOf(
      ResponsesIncidentReportGenerator,
    );
  });

  it('rejects a miswired secret without exposing its contents', async () => {
    const sensitiveValue = 'do-not-expose-this-secret';
    const readString = vi
      .fn<EvaluationSecretReader['readString']>()
      .mockResolvedValue(
        JSON.stringify({ apiKey: sensitiveValue, extra: true }),
      );

    let error: unknown;
    try {
      await createLiveEvaluationProviders(environment, { readString });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InvalidRuntimeSecretError);
    expect(String(error)).not.toContain(sensitiveValue);
  });
});
