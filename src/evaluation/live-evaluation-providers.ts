import type { IncidentAnalyzer } from '../application/ports/incident-analyzer.js';
import type { IncidentReportGenerator } from '../application/ports/incident-report-generator.js';
import type { LiveEvaluationEnvironment } from '../config/environment.js';
import { parseOpenAiApiSecret } from '../config/runtime-secrets.js';
import { ResponsesIncidentAnalyzer } from '../integrations/openai/responses-incident-analyzer.js';
import { ResponsesIncidentReportGenerator } from '../integrations/openai/responses-incident-report-generator.js';

export interface EvaluationSecretReader {
  readString(secretId: string): Promise<string>;
}

export interface LiveEvaluationProviders {
  readonly analyzer: IncidentAnalyzer;
  readonly generator: IncidentReportGenerator;
}

/** Builds billable provider adapters from one validated, runtime-only secret. */
export async function createLiveEvaluationProviders(
  environment: LiveEvaluationEnvironment,
  secrets: EvaluationSecretReader,
): Promise<LiveEvaluationProviders> {
  const secretValue = await secrets.readString(
    environment.OPENAI_API_SECRET_ARN,
  );
  const openAiSecret = parseOpenAiApiSecret(secretValue);
  return {
    analyzer: new ResponsesIncidentAnalyzer({
      apiKey: openAiSecret.apiKey,
      model: environment.OPENAI_MODEL,
      timeoutMilliseconds: environment.OPENAI_TIMEOUT_MS,
      maxOutputTokens: environment.OPENAI_MAX_OUTPUT_TOKENS,
    }),
    generator: new ResponsesIncidentReportGenerator({
      apiKey: openAiSecret.apiKey,
      model: environment.OPENAI_MODEL,
      timeoutMilliseconds: environment.OPENAI_TIMEOUT_MS,
      maxOutputTokens: environment.OPENAI_REPORT_MAX_OUTPUT_TOKENS,
    }),
  };
}
