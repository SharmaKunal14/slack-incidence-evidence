import type { IncidentAnalysis } from '../analysis/incident-analysis.js';

export interface IncidentEvidenceItem {
  readonly id: string;
  readonly sourceType: string;
  readonly occurredAt: string;
  readonly authorReference: string | null;
  readonly content: string;
}

export interface IncidentEvidenceManifest {
  readonly incidentTitle: string;
  readonly evidence: readonly IncidentEvidenceItem[];
}

export interface AnalyzeIncidentEvidenceInput {
  readonly manifest: IncidentEvidenceManifest;
  readonly availableEvidenceIds: ReadonlySet<string>;
  readonly clientRequestId: string;
}

export interface IncidentAnalyzerUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface AnalyzeIncidentEvidenceResult {
  readonly analysis: IncidentAnalysis;
  readonly providerResponseId: string;
  readonly model: string;
  readonly usage: IncidentAnalyzerUsage;
}

export interface IncidentAnalyzer {
  analyze(
    input: AnalyzeIncidentEvidenceInput,
  ): Promise<AnalyzeIncidentEvidenceResult>;
}

export class IncidentAnalyzerError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds: number | null = null,
    options?: ErrorOptions,
  ) {
    super('Incident analysis provider request failed', options);
    this.name = 'IncidentAnalyzerError';
  }
}
