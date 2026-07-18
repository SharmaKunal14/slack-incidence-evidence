import type {
  IncidentReport,
  IncidentReportManifest,
} from '../report/incident-report.js';

export interface IncidentReportDraft {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly analysisRunId: string;
  readonly draftVersion: number;
  readonly inputManifestSha256: string;
  readonly status: 'RUNNING' | 'RETRY_WAIT' | 'NEEDS_REVIEW' | 'FAILED';
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
  readonly sectionCount: number;
  readonly statementCount: number;
  readonly version: number;
}

export type AcquireIncidentReportDraftResult =
  | { readonly outcome: 'ACQUIRED'; readonly draft: IncidentReportDraft }
  | { readonly outcome: 'WAIT'; readonly retryAfterSeconds: number }
  | { readonly outcome: 'NEEDS_REVIEW'; readonly draft: IncidentReportDraft }
  | { readonly outcome: 'FAILED'; readonly draft: IncidentReportDraft };

export interface AcquireIncidentReportDraftInput {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly analysisRunId: string;
  readonly draftVersion: number;
  readonly inputManifestSha256: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly clientRequestId: string;
  readonly inputClaimCount: number;
  readonly inputTimelineEventCount: number;
  readonly inputOpenQuestionCount: number;
  readonly inputCharacters: number;
  readonly maxAttempts: number;
  readonly leaseToken: string;
  readonly now: Date;
  readonly leaseExpiresAt: Date;
}

export interface CompleteIncidentReportDraftInput {
  readonly draft: IncidentReportDraft;
  readonly leaseToken: string;
  readonly report: IncidentReport;
  readonly renderedMarkdown: string;
  readonly providerResponseId: string;
  readonly providerModel: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly completedAt: Date;
}

export interface ScheduleIncidentReportRetryInput {
  readonly draft: IncidentReportDraft;
  readonly leaseToken: string;
  readonly failureCode: string;
  readonly availableAt: Date;
  readonly now: Date;
}

export interface FailIncidentReportDraftInput {
  readonly draft: IncidentReportDraft;
  readonly leaseToken: string;
  readonly failureCode: string;
  readonly failedAt: Date;
}

export interface IncidentReportRepository {
  loadManifest(
    tenantId: string,
    incidentId: string,
    analysisRunId: string,
    sourceLimit: number,
  ): Promise<IncidentReportManifest>;
  acquire(
    input: AcquireIncidentReportDraftInput,
  ): Promise<AcquireIncidentReportDraftResult>;
  scheduleRetry(input: ScheduleIncidentReportRetryInput): Promise<void>;
  complete(
    input: CompleteIncidentReportDraftInput,
  ): Promise<IncidentReportDraft>;
  fail(input: FailIncidentReportDraftInput): Promise<IncidentReportDraft>;
}

export class IncidentReportConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IncidentReportConfigurationError';
  }
}

export class IncidentReportConcurrencyError extends Error {
  public constructor() {
    super('Incident report draft was modified concurrently');
    this.name = 'IncidentReportConcurrencyError';
  }
}
