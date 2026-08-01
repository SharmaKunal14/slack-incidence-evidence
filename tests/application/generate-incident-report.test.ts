import { describe, expect, it, vi } from 'vitest';
import { GenerateIncidentReport } from '../../src/application/generate-incident-report.js';
import {
  IncidentReportGeneratorError,
  type IncidentReportGenerator,
} from '../../src/application/ports/incident-report-generator.js';
import {
  IncidentDeidentificationError,
  type IncidentDeidentifier,
} from '../../src/application/ports/incident-deidentifier.js';
import type {
  AcquireIncidentReportDraftInput,
  AcquireIncidentReportDraftResult,
  CompleteIncidentReportDraftInput,
  FailIncidentReportDraftInput,
  IncidentReportDraft,
  IncidentReportRepository,
  ScheduleIncidentReportRetryInput,
} from '../../src/application/ports/incident-report-repository.js';
import type {
  CreateIncidentResult,
  IncidentRepository,
} from '../../src/application/ports/incident-repository.js';
import {
  INCIDENT_REPORT_SECTION_TYPES,
  type IncidentReport,
  type IncidentReportManifest,
} from '../../src/application/report/incident-report.js';
import type { Incident } from '../../src/domain/incident.js';

const tenantId = 'T001';
const incidentId = '2c6a2f4a-f762-41e9-9620-a07abdaa5c48';
const analysisRunId = 'analysis-1';
const now = new Date('2026-07-18T12:00:00.000Z');

const manifest: IncidentReportManifest = {
  incidentTitle: 'Checkout outage',
  analysisRunId,
  claims: [
    {
      id: 'claim-1',
      statement: 'Recovery followed rollback.',
      classification: 'correlated_inference',
      supportingEvidenceCount: 1,
      contradictingEvidenceCount: 0,
    },
  ],
  timeline: [],
  openQuestions: [
    {
      id: 'question-1',
      question: 'What changed?',
      evidenceIds: ['evidence-1'],
    },
  ],
};

const report: IncidentReport = {
  sections: INCIDENT_REPORT_SECTION_TYPES.map((sectionType) => ({
    sectionType,
    statements:
      sectionType === 'executive_summary'
        ? [
            {
              key: 'recovery_summary',
              statementType: 'claim' as const,
              text: 'Recovery followed rollback.',
              classification: 'correlated_inference' as const,
              claimIds: ['claim-1'],
              timelineEventIds: [],
            },
          ]
        : [],
  })),
};

class InMemoryIncidentRepository implements IncidentRepository {
  public incident: Incident = {
    id: incidentId,
    tenantId,
    sourceEventId: 'Ev001',
    sourceWorkspaceId: tenantId,
    sourceChannelId: 'C001',
    sourceMessageTs: '1721178000.000100',
    requestedByUserId: 'U001',
    title: 'Checkout outage',
    status: 'GENERATING',
    severity: 'UNCLASSIFIED',
    startedAt: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    version: 4,
  };

  public createIfAbsent(incident: Incident): Promise<CreateIncidentResult> {
    return Promise.resolve({ created: false, incident });
  }

  public findById(): Promise<Incident | null> {
    return Promise.resolve(this.incident);
  }

  public save(incident: Incident, expectedVersion: number): Promise<void> {
    if (this.incident.version !== expectedVersion) {
      return Promise.reject(new Error('concurrency failure'));
    }
    this.incident = incident;
    return Promise.resolve();
  }
}

class InMemoryReportRepository implements IncidentReportRepository {
  public mode: 'ACQUIRED' | 'NEEDS_REVIEW' = 'ACQUIRED';
  public acquiredInput: AcquireIncidentReportDraftInput | undefined;
  public completedInput: CompleteIncidentReportDraftInput | undefined;
  public retryInput: ScheduleIncidentReportRetryInput | undefined;

  public loadManifest(): Promise<IncidentReportManifest> {
    return Promise.resolve(manifest);
  }

  public acquire(
    input: AcquireIncidentReportDraftInput,
  ): Promise<AcquireIncidentReportDraftResult> {
    this.acquiredInput = input;
    const draft = draftFrom(input, this.mode);
    return Promise.resolve({ outcome: this.mode, draft });
  }

  public scheduleRetry(input: ScheduleIncidentReportRetryInput): Promise<void> {
    this.retryInput = input;
    return Promise.resolve();
  }

  public complete(
    input: CompleteIncidentReportDraftInput,
  ): Promise<IncidentReportDraft> {
    this.completedInput = input;
    return Promise.resolve({
      ...input.draft,
      status: 'NEEDS_REVIEW',
      leaseToken: null,
      leaseExpiresAt: null,
      sectionCount: input.report.sections.length,
      statementCount: input.report.sections.flatMap(
        (section) => section.statements,
      ).length,
      version: input.draft.version + 1,
    });
  }

  public fail(
    input: FailIncidentReportDraftInput,
  ): Promise<IncidentReportDraft> {
    return Promise.resolve({
      ...input.draft,
      status: 'FAILED',
      leaseToken: null,
      leaseExpiresAt: null,
      failureCode: input.failureCode,
      version: input.draft.version + 1,
    });
  }
}

function draftFrom(
  input: AcquireIncidentReportDraftInput,
  mode: 'ACQUIRED' | 'NEEDS_REVIEW',
): IncidentReportDraft {
  return {
    id: input.id,
    tenantId: input.tenantId,
    incidentId: input.incidentId,
    analysisRunId: input.analysisRunId,
    draftVersion: input.draftVersion,
    inputManifestSha256: input.inputManifestSha256,
    status: mode === 'ACQUIRED' ? 'RUNNING' : 'NEEDS_REVIEW',
    provider: input.provider,
    model: input.model,
    promptVersion: input.promptVersion,
    schemaVersion: input.schemaVersion,
    clientRequestId: input.clientRequestId,
    attemptCount: 1,
    maxAttempts: input.maxAttempts,
    availableAt: input.now,
    leaseToken: mode === 'ACQUIRED' ? input.leaseToken : null,
    leaseExpiresAt: mode === 'ACQUIRED' ? input.leaseExpiresAt : null,
    failureCode: null,
    sectionCount: mode === 'NEEDS_REVIEW' ? 10 : 0,
    statementCount: mode === 'NEEDS_REVIEW' ? 1 : 0,
    version: mode === 'NEEDS_REVIEW' ? 1 : 0,
  };
}

function useCase(
  repository: InMemoryReportRepository,
  incidents: InMemoryIncidentRepository,
  generator: IncidentReportGenerator,
  deidentifier: IncidentDeidentifier = {
    deidentify: ({ texts }) => Promise.resolve(texts),
    assertSafe: () => Promise.resolve(),
  },
): GenerateIncidentReport {
  let sequence = 0;
  return new GenerateIncidentReport(
    repository,
    incidents,
    generator,
    deidentifier,
    { now: () => now },
    { generate: () => `generated-${++sequence}` },
    {
      model: 'approved-model-snapshot',
      maxSources: 200,
      maxInputCharacters: 100_000,
      maxAttempts: 2,
      leaseSeconds: 180,
    },
  );
}

describe('GenerateIncidentReport', () => {
  it('persists a source-linked draft and advances it to human review', async () => {
    const repository = new InMemoryReportRepository();
    const incidents = new InMemoryIncidentRepository();
    const generate = vi
      .fn<IncidentReportGenerator['generate']>()
      .mockResolvedValue({
        report,
        providerResponseId: 'resp-report-1',
        model: 'approved-model-2026-07-01',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });

    await expect(
      useCase(repository, incidents, { generate }).execute({
        tenantId,
        incidentId,
        analysisRunId,
      }),
    ).resolves.toEqual({
      status: 'NEEDS_REVIEW',
      reportDraftId: 'generated-2',
      sectionCount: 10,
      statementCount: 1,
      openQuestionCount: 1,
    });

    expect(repository.acquiredInput?.inputManifestSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(repository.completedInput?.renderedMarkdown).toContain(
      'Human review is required',
    );
    expect(incidents.incident.status).toBe('NEEDS_REVIEW');
  });

  it('does not persist or render report output that fails the privacy gate', async () => {
    const repository = new InMemoryReportRepository();
    const incidents = new InMemoryIncidentRepository();
    const generate = vi
      .fn<IncidentReportGenerator['generate']>()
      .mockResolvedValue({
        report,
        providerResponseId: 'resp-report-pii',
        model: 'approved-model-2026-07-01',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });

    await expect(
      useCase(
        repository,
        incidents,
        { generate },
        {
          deidentify: ({ texts }) => Promise.resolve(texts),
          assertSafe: () =>
            Promise.reject(
              new IncidentDeidentificationError('PII_REMAINS', false),
            ),
        },
      ).execute({ tenantId, incidentId, analysisRunId }),
    ).resolves.toMatchObject({ status: 'FAILED', failureCode: 'PII_REMAINS' });

    expect(repository.completedInput).toBeUndefined();
    expect(incidents.incident.status).toBe('FAILED');
  });

  it('returns an existing completed draft without a second model call', async () => {
    const repository = new InMemoryReportRepository();
    repository.mode = 'NEEDS_REVIEW';
    const incidents = new InMemoryIncidentRepository();
    incidents.incident = { ...incidents.incident, status: 'NEEDS_REVIEW' };
    const generate = vi.fn<IncidentReportGenerator['generate']>();

    await expect(
      useCase(repository, incidents, { generate }).execute({
        tenantId,
        incidentId,
        analysisRunId,
      }),
    ).resolves.toMatchObject({
      status: 'NEEDS_REVIEW',
      sectionCount: 10,
      statementCount: 1,
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('persists an explicit bounded retry after provider throttling', async () => {
    const repository = new InMemoryReportRepository();
    const incidents = new InMemoryIncidentRepository();
    const generate = vi
      .fn<IncidentReportGenerator['generate']>()
      .mockRejectedValue(
        new IncidentReportGeneratorError(
          'OPENAI_REPORT_RATE_LIMITED',
          true,
          12,
        ),
      );

    await expect(
      useCase(repository, incidents, { generate }).execute({
        tenantId,
        incidentId,
        analysisRunId,
      }),
    ).resolves.toEqual({ status: 'RETRY_WAIT', retryAfterSeconds: 12 });
    expect(repository.retryInput).toMatchObject({
      failureCode: 'OPENAI_REPORT_RATE_LIMITED',
    });
    expect(incidents.incident.status).toBe('GENERATING');
  });
});
