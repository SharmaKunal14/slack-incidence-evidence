import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { IncidentAnalysisConfigurationError } from '../../../src/application/ports/incident-analysis-repository.js';
import { PostgresIncidentAnalysisRepository } from '../../../src/infrastructure/postgres/incident-analysis-repository.js';

const now = new Date('2026-07-18T02:00:00.000Z');
const leaseExpiresAt = new Date('2026-07-18T02:03:00.000Z');

const acquireInput = {
  id: 'run-1',
  tenantId: 'T001',
  incidentId: '2c6a2f4a-f762-41e9-9620-a07abdaa5c48',
  analysisVersion: 1,
  manifestSha256: 'a'.repeat(64),
  provider: 'openai',
  model: 'approved-model-snapshot',
  promptVersion: 'incident-extraction-v1',
  schemaVersion: 'incident-analysis-v1',
  clientRequestId: 'client-request-1',
  inputArtifactCount: 1,
  inputCharacters: 500,
  maxAttempts: 2,
  leaseToken: 'lease-1',
  now,
  leaseExpiresAt,
};

const runningRow = {
  id: acquireInput.id,
  tenant_id: acquireInput.tenantId,
  incident_id: acquireInput.incidentId,
  analysis_version: acquireInput.analysisVersion,
  manifest_sha256: acquireInput.manifestSha256,
  status: 'RUNNING',
  provider: acquireInput.provider,
  model_name: acquireInput.model,
  prompt_version: acquireInput.promptVersion,
  schema_version: acquireInput.schemaVersion,
  client_request_id: acquireInput.clientRequestId,
  input_artifact_count: acquireInput.inputArtifactCount,
  input_characters: acquireInput.inputCharacters,
  attempt_count: 1,
  max_attempts: acquireInput.maxAttempts,
  available_at: now,
  lease_token: acquireInput.leaseToken,
  lease_expires_at: leaseExpiresAt,
  failure_code: null,
  timeline_event_count: 0,
  claim_count: 0,
  open_question_count: 0,
  version: 0,
};

function result<Row extends QueryResultRow>(
  rows: Row[],
  rowCount = rows.length,
): QueryResult<Row> {
  return { command: '', fields: [], oid: 0, rowCount, rows };
}

function repositoryWithClient(
  queryResults: readonly QueryResult<QueryResultRow>[],
): {
  readonly repository: PostgresIncidentAnalysisRepository;
  readonly query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn();
  for (const queryResult of queryResults) {
    query.mockResolvedValueOnce(queryResult);
  }
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return { repository: new PostgresIncidentAnalysisRepository(pool), query };
}

describe('PostgresIncidentAnalysisRepository', () => {
  it('acquires the first immutable analysis version transactionally', async () => {
    const { repository, query } = repositoryWithClient([
      result([]),
      result([runningRow]),
      result([]),
    ]);

    await expect(repository.acquire(acquireInput)).resolves.toMatchObject({
      outcome: 'ACQUIRED',
      run: { id: 'run-1', status: 'RUNNING', attemptCount: 1 },
    });

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        'ON CONFLICT (tenant_id, incident_id, analysis_version) DO NOTHING',
      ),
      expect.arrayContaining([
        acquireInput.tenantId,
        acquireInput.incidentId,
        acquireInput.manifestSha256,
        acquireInput.leaseToken,
      ]),
    );
    expect(query).toHaveBeenNthCalledWith(3, 'COMMIT');
  });

  it('makes a duplicate invocation wait behind the active database lease', async () => {
    const futureLease = new Date('2026-07-18T02:01:30.000Z');
    const { repository, query } = repositoryWithClient([
      result([]),
      result([]),
      result([{ ...runningRow, lease_expires_at: futureLease }]),
      result([]),
    ]);

    await expect(repository.acquire(acquireInput)).resolves.toEqual({
      outcome: 'WAIT',
      retryAfterSeconds: 90,
    });

    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('FOR UPDATE'),
      [
        acquireInput.tenantId,
        acquireInput.incidentId,
        acquireInput.analysisVersion,
      ],
    );
    expect(query).toHaveBeenNthCalledWith(4, 'COMMIT');
  });

  it('refuses to reuse an analysis version after its evidence changes', async () => {
    const { repository, query } = repositoryWithClient([
      result([]),
      result([]),
      result([{ ...runningRow, manifest_sha256: 'b'.repeat(64) }]),
      result([]),
    ]);

    await expect(repository.acquire(acquireInput)).rejects.toBeInstanceOf(
      IncidentAnalysisConfigurationError,
    );
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('atomically writes generated records, citations, usage, and completion', async () => {
    const completedRow = {
      ...runningRow,
      status: 'COMPLETE',
      lease_token: null,
      lease_expires_at: null,
      timeline_event_count: 1,
      claim_count: 1,
      open_question_count: 1,
      version: 1,
    };
    const { repository, query } = repositoryWithClient([
      result([]),
      result([]),
      result([]),
      result([]),
      result([]),
      result([]),
      result([]),
      result([completedRow]),
      result([]),
    ]);

    await expect(
      repository.complete({
        run: {
          id: runningRow.id,
          tenantId: runningRow.tenant_id,
          incidentId: runningRow.incident_id,
          analysisVersion: runningRow.analysis_version,
          manifestSha256: runningRow.manifest_sha256,
          status: 'RUNNING',
          provider: runningRow.provider,
          model: runningRow.model_name,
          promptVersion: runningRow.prompt_version,
          schemaVersion: runningRow.schema_version,
          clientRequestId: runningRow.client_request_id,
          attemptCount: runningRow.attempt_count,
          maxAttempts: runningRow.max_attempts,
          availableAt: now,
          leaseToken: runningRow.lease_token,
          leaseExpiresAt,
          failureCode: null,
          timelineEventCount: 0,
          claimCount: 0,
          openQuestionCount: 0,
          version: 0,
        },
        leaseToken: acquireInput.leaseToken,
        analysis: {
          timeline: [
            {
              key: 'rollback_started',
              occurredAt: '2026-07-18T01:00:00.000Z',
              summary: 'Rollback started.',
              classification: 'directly_observed',
              evidenceIds: ['artifact-1'],
            },
          ],
          claims: [
            {
              key: 'rollback_reduced_errors',
              statement: 'Errors declined after rollback.',
              classification: 'correlated_inference',
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
        },
        providerResponseId: 'resp-1',
        providerModel: 'approved-model-2026-07-01',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        completedAt: now,
      }),
    ).resolves.toMatchObject({
      status: 'COMPLETE',
      timelineEventCount: 1,
      claimCount: 1,
      openQuestionCount: 1,
    });

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO timeline_event_evidence_links'),
      expect.arrayContaining([
        acquireInput.tenantId,
        acquireInput.incidentId,
        'artifact-1',
      ]),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO claim_evidence_links'),
      expect.arrayContaining(['artifact-1', 'SUPPORTS']),
    );
    expect(query).toHaveBeenNthCalledWith(9, 'COMMIT');
  });
});
