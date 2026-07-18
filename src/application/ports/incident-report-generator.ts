import type {
  IncidentReport,
  IncidentReportManifest,
} from '../report/incident-report.js';

export interface GenerateIncidentReportInput {
  readonly manifest: IncidentReportManifest;
  readonly clientRequestId: string;
}

export interface IncidentReportGeneratorUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface GenerateIncidentReportResult {
  readonly report: IncidentReport;
  readonly providerResponseId: string;
  readonly model: string;
  readonly usage: IncidentReportGeneratorUsage;
}

export interface IncidentReportGenerator {
  generate(
    input: GenerateIncidentReportInput,
  ): Promise<GenerateIncidentReportResult>;
}

export class IncidentReportGeneratorError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds: number | null = null,
    options?: ErrorOptions,
  ) {
    super('Incident report provider request failed', options);
    this.name = 'IncidentReportGeneratorError';
  }
}
