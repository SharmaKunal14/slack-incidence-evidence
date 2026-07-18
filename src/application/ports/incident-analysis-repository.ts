import type { IncidentAnalysis } from '../analysis/incident-analysis.js';

export interface IncidentAnalysisEvidenceArtifact {
  readonly id: string;
  readonly sourceType: string;
  readonly occurredAt: Date;
  readonly authorExternalId: string | null;
  readonly content: string;
}

export interface IncidentAnalysisEvidenceBundle {
  readonly incidentTitle: string;
  readonly artifacts: readonly IncidentAnalysisEvidenceArtifact[];
}

export interface IncidentAnalysisRun {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly analysisVersion: number;
  readonly manifestSha256: string;
  readonly status: 'RUNNING' | 'RETRY_WAIT' | 'COMPLETE' | 'FAILED';
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly clientRequestId: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly availableAt: Date;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly failureCode: string | null;
  readonly timelineEventCount: number;
  readonly claimCount: number;
  readonly openQuestionCount: number;
  readonly version: number;
}

export type AcquireIncidentAnalysisRunResult =
  | { readonly outcome: 'ACQUIRED'; readonly run: IncidentAnalysisRun }
  | { readonly outcome: 'WAIT'; readonly retryAfterSeconds: number }
  | { readonly outcome: 'COMPLETE'; readonly run: IncidentAnalysisRun }
  | { readonly outcome: 'FAILED'; readonly run: IncidentAnalysisRun };

export interface AcquireIncidentAnalysisRunInput {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly analysisVersion: number;
  readonly manifestSha256: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly clientRequestId: string;
  readonly inputArtifactCount: number;
  readonly inputCharacters: number;
  readonly maxAttempts: number;
  readonly leaseToken: string;
  readonly now: Date;
  readonly leaseExpiresAt: Date;
}

export interface ScheduleIncidentAnalysisRetryInput {
  readonly run: IncidentAnalysisRun;
  readonly leaseToken: string;
  readonly failureCode: string;
  readonly availableAt: Date;
  readonly now: Date;
}

export interface CompleteIncidentAnalysisInput {
  readonly run: IncidentAnalysisRun;
  readonly leaseToken: string;
  readonly analysis: IncidentAnalysis;
  readonly providerResponseId: string;
  readonly providerModel: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly completedAt: Date;
}

export interface FailIncidentAnalysisInput {
  readonly run: IncidentAnalysisRun;
  readonly leaseToken: string;
  readonly failureCode: string;
  readonly failedAt: Date;
}

export interface IncidentAnalysisRepository {
  loadEvidence(
    tenantId: string,
    incidentId: string,
    artifactLimit: number,
  ): Promise<IncidentAnalysisEvidenceBundle>;
  acquire(
    input: AcquireIncidentAnalysisRunInput,
  ): Promise<AcquireIncidentAnalysisRunResult>;
  scheduleRetry(input: ScheduleIncidentAnalysisRetryInput): Promise<void>;
  complete(input: CompleteIncidentAnalysisInput): Promise<IncidentAnalysisRun>;
  fail(input: FailIncidentAnalysisInput): Promise<IncidentAnalysisRun>;
}

export class IncidentAnalysisConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IncidentAnalysisConfigurationError';
  }
}

export class IncidentAnalysisConcurrencyError extends Error {
  public constructor() {
    super('Incident analysis run was modified concurrently');
    this.name = 'IncidentAnalysisConcurrencyError';
  }
}
