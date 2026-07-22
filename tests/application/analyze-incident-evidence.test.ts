import { describe, expect, it, vi } from 'vitest';
import { AnalyzeIncidentEvidence } from '../../src/application/analyze-incident-evidence.js';
import type {
  AcquireIncidentAnalysisRunInput,
  AcquireIncidentAnalysisRunResult,
  CompleteIncidentAnalysisInput,
  FailIncidentAnalysisInput,
  IncidentAnalysisEvidenceBundle,
  IncidentAnalysisRepository,
  IncidentAnalysisRun,
  ScheduleIncidentAnalysisRetryInput,
} from '../../src/application/ports/incident-analysis-repository.js';
import {
  IncidentAnalyzerError,
  type IncidentAnalyzer,
} from '../../src/application/ports/incident-analyzer.js';
import type {
  CreateIncidentResult,
  IncidentRepository,
} from '../../src/application/ports/incident-repository.js';
import type { Incident } from '../../src/domain/incident.js';

const tenantId = 'T001';
const incidentId = '2c6a2f4a-f762-41e9-9620-a07abdaa5c48';
const now = new Date('2026-07-18T02:00:00.000Z');

const evidence: IncidentAnalysisEvidenceBundle = {
  incidentTitle: 'Checkout outage',
  artifacts: [
    {
      id: 'artifact-1',
      sourceType: 'SLACK_MESSAGE',
      occurredAt: new Date('2026-07-18T01:00:00.000Z'),
      authorExternalId: 'U001',
      content: 'Rollback started and error rates declined.',
    },
  ],
};

const analysis = {
  timeline: [
    {
      key: 'rollback_started',
      occurredAt: '2026-07-18T01:00:00.000Z',
      summary: 'The rollback started.',
      classification: 'participant_assertion' as const,
      evidenceIds: ['artifact-1'],
    },
  ],
  claims: [
    {
      key: 'error_rate_declined',
      statement: 'Error rates declined after rollback began.',
      classification: 'correlated_inference' as const,
      supportingEvidenceIds: ['artifact-1'],
      contradictingEvidenceIds: [],
    },
  ],
  openQuestions: [
    {
      key: 'rollback_recovery_unknown',
      question: 'Did the rollback fully restore service?',
      evidenceIds: ['artifact-1'],
    },
  ],
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
    status: 'COLLECTING',
    severity: 'UNCLASSIFIED',
    startedAt: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };

  public createIfAbsent(incident: Incident): Promise<CreateIncidentResult> {
    return Promise.resolve({ created: false, incident });
  }

  public findById(
    requestedTenantId: string,
    requestedIncidentId: string,
  ): Promise<Incident | null> {
    return Promise.resolve(
      requestedTenantId === tenantId && requestedIncidentId === incidentId
        ? this.incident
        : null,
    );
  }

  public save(incident: Incident, expectedVersion: number): Promise<void> {
    if (this.incident.version !== expectedVersion) {
      return Promise.reject(new Error('concurrency failure'));
    }
    this.incident = incident;
    return Promise.resolve();
  }
}

class InMemoryAnalysisRepository implements IncidentAnalysisRepository {
  public mode: 'ACQUIRED' | 'COMPLETE' = 'ACQUIRED';
  public evidence = evidence;
  public acquiredInput: AcquireIncidentAnalysisRunInput | undefined;
  public completedInput: CompleteIncidentAnalysisInput | undefined;
  public failedInput: FailIncidentAnalysisInput | undefined;
  public retryInput: ScheduleIncidentAnalysisRetryInput | undefined;

  public loadEvidence(): Promise<IncidentAnalysisEvidenceBundle> {
    return Promise.resolve(this.evidence);
  }

  public acquire(
    input: AcquireIncidentAnalysisRunInput,
  ): Promise<AcquireIncidentAnalysisRunResult> {
    this.acquiredInput = input;
    const run = runFrom(input, this.mode);
    return Promise.resolve({ outcome: this.mode, run });
  }

  public scheduleRetry(
    input: ScheduleIncidentAnalysisRetryInput,
  ): Promise<void> {
    this.retryInput = input;
    return Promise.resolve();
  }

  public complete(
    input: CompleteIncidentAnalysisInput,
  ): Promise<IncidentAnalysisRun> {
    this.completedInput = input;
    return Promise.resolve({
      ...input.run,
      status: 'COMPLETE',
      leaseToken: null,
      leaseExpiresAt: null,
      timelineEventCount: input.analysis.timeline.length,
      claimCount: input.analysis.claims.length,
      openQuestionCount: input.analysis.openQuestions.length,
      version: input.run.version + 1,
    });
  }

  public fail(input: FailIncidentAnalysisInput): Promise<IncidentAnalysisRun> {
    this.failedInput = input;
    return Promise.resolve({
      ...input.run,
      status: 'FAILED',
      leaseToken: null,
      leaseExpiresAt: null,
      failureCode: input.failureCode,
      version: input.run.version + 1,
    });
  }
}

function runFrom(
  input: AcquireIncidentAnalysisRunInput,
  status: 'ACQUIRED' | 'COMPLETE',
): IncidentAnalysisRun {
  return {
    id: input.id,
    tenantId: input.tenantId,
    incidentId: input.incidentId,
    analysisVersion: input.analysisVersion,
    manifestSha256: input.manifestSha256,
    status: status === 'ACQUIRED' ? 'RUNNING' : 'COMPLETE',
    provider: input.provider,
    model: input.model,
    promptVersion: input.promptVersion,
    schemaVersion: input.schemaVersion,
    clientRequestId: input.clientRequestId,
    attemptCount: 1,
    maxAttempts: input.maxAttempts,
    availableAt: input.now,
    leaseToken: status === 'ACQUIRED' ? input.leaseToken : null,
    leaseExpiresAt: status === 'ACQUIRED' ? input.leaseExpiresAt : null,
    failureCode: null,
    timelineEventCount: status === 'COMPLETE' ? 1 : 0,
    claimCount: status === 'COMPLETE' ? 1 : 0,
    openQuestionCount: status === 'COMPLETE' ? 1 : 0,
    version: status === 'COMPLETE' ? 1 : 0,
  };
}

function useCase(
  repository: InMemoryAnalysisRepository,
  incidents: InMemoryIncidentRepository,
  analyzer: IncidentAnalyzer,
): AnalyzeIncidentEvidence {
  let generatedId = 0;
  return new AnalyzeIncidentEvidence(
    repository,
    incidents,
    analyzer,
    { now: () => now },
    { generate: () => `generated-${++generatedId}` },
    {
      model: 'approved-model-snapshot',
      maxArtifacts: 100,
      maxInputCharacters: 100_000,
      maxAttempts: 2,
      leaseSeconds: 180,
    },
  );
}

describe('AnalyzeIncidentEvidence', () => {
  it('builds a bounded manifest and persists a completed cited analysis', async () => {
    const repository = new InMemoryAnalysisRepository();
    const incidents = new InMemoryIncidentRepository();
    const analyze = vi.fn<IncidentAnalyzer['analyze']>().mockResolvedValue({
      analysis,
      providerResponseId: 'resp-1',
      model: 'approved-model-2026-07-01',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    await expect(
      useCase(repository, incidents, { analyze }).execute({
        tenantId,
        incidentId,
      }),
    ).resolves.toEqual({
      status: 'COMPLETE',
      analysisRunId: 'generated-2',
      timelineEventCount: 1,
      claimCount: 1,
      openQuestionCount: 1,
    });

    expect(analyze).toHaveBeenCalledWith({
      manifest: {
        incidentTitle: 'Checkout outage',
        evidence: [
          {
            id: 'artifact-1',
            sourceType: 'SLACK_MESSAGE',
            occurredAt: '2026-07-18T01:00:00.000Z',
            authorReference: 'participant_1',
            content: 'Rollback started and error rates declined.',
          },
        ],
      },
      availableEvidenceIds: new Set(['artifact-1']),
      clientRequestId: 'generated-3',
    });
    expect(repository.acquiredInput?.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(repository.completedInput?.providerResponseId).toBe('resp-1');
    expect(incidents.incident.status).toBe('GENERATING');
  });

  it('waits durably after an explicit retryable provider response', async () => {
    const repository = new InMemoryAnalysisRepository();
    const incidents = new InMemoryIncidentRepository();
    const analyzer: IncidentAnalyzer = {
      analyze: () =>
        Promise.reject(
          new IncidentAnalyzerError('OPENAI_RATE_LIMITED', true, 17),
        ),
    };

    await expect(
      useCase(repository, incidents, analyzer).execute({
        tenantId,
        incidentId,
      }),
    ).resolves.toEqual({ status: 'RETRY_WAIT', retryAfterSeconds: 17 });

    expect(repository.retryInput?.failureCode).toBe('OPENAI_RATE_LIMITED');
    expect(repository.failedInput).toBeUndefined();
    expect(incidents.incident.status).toBe('EXTRACTING');
  });

  it('pseudonymizes explicit Slack author IDs before provider submission', async () => {
    const repository = new InMemoryAnalysisRepository();
    repository.evidence = {
      ...evidence,
      artifacts: [
        evidence.artifacts[0]!,
        {
          ...evidence.artifacts[0]!,
          id: 'artifact-2',
          authorExternalId: 'U001',
        },
        {
          ...evidence.artifacts[0]!,
          id: 'artifact-3',
          authorExternalId: 'U002',
        },
      ],
    };
    const incidents = new InMemoryIncidentRepository();
    const analyze = vi
      .fn<IncidentAnalyzer['analyze']>()
      .mockImplementation((input) => {
        expect(
          input.manifest.evidence.map((item) => item.authorReference),
        ).toEqual(['participant_1', 'participant_1', 'participant_2']);
        expect(JSON.stringify(input.manifest)).not.toContain('U001');
        expect(JSON.stringify(input.manifest)).not.toContain('U002');
        return Promise.resolve({
          analysis: { timeline: [], claims: [], openQuestions: [] },
          providerResponseId: 'resp-1',
          model: 'approved-model-2026-07-01',
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        });
      });

    await useCase(repository, incidents, { analyze }).execute({
      tenantId,
      incidentId,
    });
    expect(analyze).toHaveBeenCalledOnce();
  });

  it('fails closed on an ambiguous provider outcome', async () => {
    const repository = new InMemoryAnalysisRepository();
    const incidents = new InMemoryIncidentRepository();
    const analyzer: IncidentAnalyzer = {
      analyze: () =>
        Promise.reject(
          new IncidentAnalyzerError('OPENAI_OUTCOME_UNKNOWN', false),
        ),
    };

    await expect(
      useCase(repository, incidents, analyzer).execute({
        tenantId,
        incidentId,
      }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      failureCode: 'OPENAI_OUTCOME_UNKNOWN',
    });
    expect(incidents.incident.status).toBe('FAILED');
  });

  it('returns a durable completion without calling the model twice', async () => {
    const repository = new InMemoryAnalysisRepository();
    repository.mode = 'COMPLETE';
    const incidents = new InMemoryIncidentRepository();
    const analyze = vi.fn<IncidentAnalyzer['analyze']>();

    await expect(
      useCase(repository, incidents, { analyze }).execute({
        tenantId,
        incidentId,
      }),
    ).resolves.toMatchObject({ status: 'COMPLETE' });

    expect(analyze).not.toHaveBeenCalled();
    expect(incidents.incident.status).toBe('GENERATING');
  });

  it('rejects oversized evidence before acquiring a model lease', async () => {
    const repository = new InMemoryAnalysisRepository();
    repository.evidence = {
      ...evidence,
      artifacts: [...evidence.artifacts, ...evidence.artifacts],
    };
    const incidents = new InMemoryIncidentRepository();
    const analyze = vi.fn<IncidentAnalyzer['analyze']>();
    let generatedId = 0;
    const analyzer = new AnalyzeIncidentEvidence(
      repository,
      incidents,
      { analyze },
      { now: () => now },
      { generate: () => `generated-${++generatedId}` },
      {
        model: 'approved-model-snapshot',
        maxArtifacts: 1,
        maxInputCharacters: 100_000,
        maxAttempts: 2,
        leaseSeconds: 180,
      },
    );

    await expect(analyzer.execute({ tenantId, incidentId })).rejects.toThrow(
      'artifact limit',
    );
    expect(repository.acquiredInput).toBeUndefined();
    expect(analyze).not.toHaveBeenCalled();
  });

  it('does not call the model for an incident already in a terminal state', async () => {
    const repository = new InMemoryAnalysisRepository();
    const incidents = new InMemoryIncidentRepository();
    incidents.incident = { ...incidents.incident, status: 'FAILED' };
    const analyze = vi.fn<IncidentAnalyzer['analyze']>();

    await expect(
      useCase(repository, incidents, { analyze }).execute({
        tenantId,
        incidentId,
      }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      failureCode: 'INCIDENT_ALREADY_FAILED',
    });
    expect(analyze).not.toHaveBeenCalled();
  });
});
