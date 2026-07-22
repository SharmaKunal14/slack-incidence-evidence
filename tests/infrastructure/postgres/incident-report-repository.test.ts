import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { INCIDENT_REPORT_SECTION_TYPES } from '../../../src/application/report/incident-report.js';
import { PostgresIncidentReportRepository } from '../../../src/infrastructure/postgres/incident-report-repository.js';

const now = new Date('2026-07-18T04:00:00.000Z');
const leaseExpiresAt = new Date('2026-07-18T04:03:00.000Z');

const acquireInput = {
  id: 'report-1',
  tenantId: 'T001',
  incidentId: '2c6a2f4a-f762-41e9-9620-a07abdaa5c48',
  analysisRunId: 'analysis-1',
  draftVersion: 1,
  inputManifestSha256: 'a'.repeat(64),
  provider: 'openai',
  model: 'approved-model-snapshot',
  promptVersion: 'incident-report-v1',
  schemaVersion: 'incident-report-v1',
  clientRequestId: 'client-request-1',
  inputClaimCount: 1,
  inputTimelineEventCount: 1,
  inputOpenQuestionCount: 1,
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
  analysis_run_id: acquireInput.analysisRunId,
  draft_version: acquireInput.draftVersion,
  input_manifest_sha256: acquireInput.inputManifestSha256,
  status: 'RUNNING',
  provider: acquireInput.provider,
  model_name: acquireInput.model,
  prompt_version: acquireInput.promptVersion,
  schema_version: acquireInput.schemaVersion,
  client_request_id: acquireInput.clientRequestId,
  input_claim_count: acquireInput.inputClaimCount,
  input_timeline_event_count: acquireInput.inputTimelineEventCount,
  input_open_question_count: acquireInput.inputOpenQuestionCount,
  input_characters: acquireInput.inputCharacters,
  attempt_count: 1,
  max_attempts: acquireInput.maxAttempts,
  available_at: now,
  lease_token: acquireInput.leaseToken,
  lease_expires_at: leaseExpiresAt,
  failure_code: null,
  section_count: 0,
  statement_count: 0,
  version: 0,
};

function result<Row extends QueryResultRow>(
  rows: Row[],
  rowCount = rows.length,
): QueryResult<Row> {
  return { command: '', fields: [], oid: 0, rowCount, rows };
}

describe('PostgresIncidentReportRepository', () => {
  it('authorizes one exact tenant-scoped review-ready draft', async () => {
    const query = vi.fn().mockResolvedValue(
      result([
        {
          id: acquireInput.id,
          input_timeline_event_count: '3',
          input_claim_count: '2',
          input_open_question_count: '1',
        },
      ]),
    );
    const pool = { query } as unknown as Pool;

    await expect(
      new PostgresIncidentReportRepository(pool).findReadyDraft(
        acquireInput.tenantId,
        acquireInput.incidentId,
        acquireInput.id,
      ),
    ).resolves.toEqual({
      id: acquireInput.id,
      timelineEventCount: 3,
      claimCount: 2,
      openQuestionCount: 1,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'NEEDS_REVIEW'"),
      [acquireInput.tenantId, acquireInput.incidentId, acquireInput.id],
    );
  });

  it('loads only tenant-scoped structured sources from a completed analysis', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(
        result([{ title: 'Checkout outage', analysis_status: 'COMPLETE' }]),
      )
      .mockResolvedValueOnce(
        result([
          {
            id: 'claim-1',
            statement: 'Recovery followed rollback.',
            classification: 'CORRELATED_INFERENCE',
            supporting_evidence_count: '2',
            contradicting_evidence_count: '0',
          },
        ]),
      )
      .mockResolvedValueOnce(
        result([
          {
            id: 'timeline-1',
            event_time: now,
            summary: 'Rollback completed.',
            classification: 'DIRECTLY_OBSERVED',
            evidence_count: '1',
          },
        ]),
      )
      .mockResolvedValueOnce(
        result([
          {
            id: 'question-1',
            question: 'What changed?',
            evidence_ids: ['evidence-1'],
          },
        ]),
      )
      .mockResolvedValueOnce(
        result([
          {
            source_id: 'source-1',
            display_name: 'incident-checkout',
            provider_source_id: 'C001',
            source_state: 'COMPLETE',
            collected_message_count: 46,
            completion_or_failure_reason: 'WINDOW_COLLECTED',
          },
        ]),
      );
    const pool = { query } as unknown as Pool;

    await expect(
      new PostgresIncidentReportRepository(pool).loadManifest(
        acquireInput.tenantId,
        acquireInput.incidentId,
        acquireInput.analysisRunId,
        201,
      ),
    ).resolves.toEqual({
      incidentTitle: 'Checkout outage',
      analysisRunId: 'analysis-1',
      claims: [
        {
          id: 'claim-1',
          statement: 'Recovery followed rollback.',
          classification: 'correlated_inference',
          supportingEvidenceCount: 2,
          contradictingEvidenceCount: 0,
        },
      ],
      timeline: [
        {
          id: 'timeline-1',
          occurredAt: now.toISOString(),
          summary: 'Rollback completed.',
          classification: 'directly_observed',
          evidenceCount: 1,
        },
      ],
      openQuestions: [
        {
          id: 'question-1',
          question: 'What changed?',
          evidenceIds: ['evidence-1'],
        },
      ],
      coverage: [
        {
          sourceId: 'source-1',
          sourceName: '#incident-checkout',
          state: 'COMPLETE',
          messageCount: 46,
          reason: 'WINDOW_COLLECTED',
        },
      ],
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('FROM incidents i'),
      [
        acquireInput.tenantId,
        acquireInput.incidentId,
        acquireInput.analysisRunId,
      ],
    );
    for (const callNumber of [2, 3, 4]) {
      expect(query).toHaveBeenNthCalledWith(callNumber, expect.any(String), [
        acquireInput.tenantId,
        acquireInput.incidentId,
        acquireInput.analysisRunId,
        201,
      ]);
    }
  });

  it('acquires the first immutable report version transactionally', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([runningRow]))
      .mockResolvedValueOnce(result([]));
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;

    await expect(
      new PostgresIncidentReportRepository(pool).acquire(acquireInput),
    ).resolves.toMatchObject({
      outcome: 'ACQUIRED',
      draft: { id: 'report-1', status: 'RUNNING', attemptCount: 1 },
    });

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        'ON CONFLICT (\n            tenant_id,\n            incident_id,\n            analysis_run_id,\n            draft_version\n          ) DO NOTHING',
      ),
      expect.arrayContaining([
        acquireInput.tenantId,
        acquireInput.incidentId,
        acquireInput.inputManifestSha256,
        acquireInput.leaseToken,
      ]),
    );
    expect(query).toHaveBeenNthCalledWith(3, 'COMMIT');
  });

  it('atomically persists every section, statement, source link, and completion', async () => {
    const completedRow = {
      ...runningRow,
      status: 'NEEDS_REVIEW',
      lease_token: null,
      lease_expires_at: null,
      section_count: INCIDENT_REPORT_SECTION_TYPES.length,
      statement_count: 2,
      version: 1,
    };
    const query = vi.fn((sql: string) => {
      if (sql.includes('UPDATE incident_report_drafts')) {
        return Promise.resolve(result([completedRow]));
      }
      return Promise.resolve(result([]));
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;
    const draft = {
      id: runningRow.id,
      tenantId: runningRow.tenant_id,
      incidentId: runningRow.incident_id,
      analysisRunId: runningRow.analysis_run_id,
      draftVersion: runningRow.draft_version,
      inputManifestSha256: runningRow.input_manifest_sha256,
      status: 'RUNNING' as const,
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
      sectionCount: 0,
      statementCount: 0,
      version: 0,
    };

    await expect(
      new PostgresIncidentReportRepository(pool).complete({
        draft,
        leaseToken: acquireInput.leaseToken,
        report: {
          sections: INCIDENT_REPORT_SECTION_TYPES.map((sectionType) => ({
            sectionType,
            statements:
              sectionType === 'executive_summary'
                ? [
                    {
                      key: 'recovery_followed_rollback',
                      statementType: 'claim' as const,
                      text: 'Recovery followed rollback.',
                      classification: 'correlated_inference' as const,
                      claimIds: ['claim-1'],
                      timelineEventIds: [],
                    },
                  ]
                : sectionType === 'timeline'
                  ? [
                      {
                        key: 'rollback_completed',
                        statementType: 'timeline' as const,
                        text: 'Rollback completed.',
                        classification: 'directly_observed' as const,
                        claimIds: [],
                        timelineEventIds: ['timeline-1'],
                      },
                    ]
                  : [],
          })),
        },
        renderedMarkdown: '# Draft\n',
        providerResponseId: 'response-1',
        providerModel: 'approved-model-snapshot',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        completedAt: now,
      }),
    ).resolves.toMatchObject({
      status: 'NEEDS_REVIEW',
      sectionCount: 10,
      statementCount: 2,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO report_statement_claim_links'),
      expect.arrayContaining([
        acquireInput.tenantId,
        acquireInput.incidentId,
        'claim-1',
      ]),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        'INSERT INTO report_statement_timeline_event_links',
      ),
      expect.arrayContaining([
        acquireInput.tenantId,
        acquireInput.incidentId,
        'timeline-1',
      ]),
    );
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });
});
