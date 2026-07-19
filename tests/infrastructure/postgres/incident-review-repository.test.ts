import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  ReviewConfigurationError,
  ReviewConflictError,
} from '../../../src/application/review/incident-review.js';
import type {
  ApproveReportRevisionInput,
  CreateReportRevisionInput,
} from '../../../src/application/ports/incident-review-repository.js';
import { PostgresIncidentReviewRepository } from '../../../src/infrastructure/postgres/incident-review-repository.js';

const now = new Date('2026-07-18T01:00:00.000Z');
const incidentId = '2c6a2f4a-f762-41e9-9620-a07abdaa5c48';
const revisionId = '617b5728-8404-4934-a616-1a319ba72b7f';
const subject = '9f218e92-36a8-455d-869c-a76e27b399df';
const reportDraftId = '7df1bcac-5583-4cd6-91db-981989f4c482';

function result<Row extends QueryResultRow>(
  rows: Row[],
  rowCount = rows.length,
): QueryResult<Row> {
  return { command: '', fields: [], oid: 0, rowCount, rows };
}

function revisionRow(status: 'DRAFT' | 'APPROVED' = 'DRAFT'): {
  readonly id: string;
  readonly tenant_id: string;
  readonly incident_id: string;
  readonly report_draft_id: string;
  readonly revision_number: number;
  readonly status: 'DRAFT' | 'APPROVED';
  readonly created_by_subject: string;
  readonly request_sha256: string;
  readonly acknowledged_contradictions: boolean;
  readonly acknowledged_open_questions: boolean;
  readonly statement_count: number;
  readonly rendered_markdown: string;
  readonly content_sha256: string;
  readonly created_at: Date;
  readonly approved_by_subject: string | null;
  readonly approved_at: Date | null;
} {
  return {
    id: revisionId,
    tenant_id: 'tenant-1',
    incident_id: incidentId,
    report_draft_id: reportDraftId,
    revision_number: 2,
    status,
    created_by_subject: subject,
    request_sha256: 'a'.repeat(64),
    acknowledged_contradictions: true,
    acknowledged_open_questions: true,
    statement_count: 3,
    rendered_markdown: '# Reviewed',
    content_sha256: 'b'.repeat(64),
    created_at: now,
    approved_by_subject: status === 'APPROVED' ? subject : null,
    approved_at: status === 'APPROVED' ? now : null,
  };
}

function approvalInput(): ApproveReportRevisionInput {
  return {
    approvalId: 'a98b82aa-707e-4fbd-9356-c5f4bfa90f33',
    auditEventId: '47a988cf-b468-443b-a822-c6bbb76012fb',
    reviewer: { subject },
    incidentId,
    revisionId,
    expectedIncidentVersion: 4,
    clientRequestId: 'd61ad8d8-5111-4ce0-a044-1addc5bf0414',
    approvedAt: now,
  };
}

describe('PostgresIncidentReviewRepository approval', () => {
  it('authorizes, locks the newest revision, and commits approval atomically', async () => {
    const locked = {
      ...revisionRow(),
      incident_status: 'NEEDS_REVIEW',
      incident_version: 4,
      contradiction_count: '1',
      open_question_count: 1,
    };
    const approved = revisionRow('APPROVED');
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([
          {
            tenant_id: 'tenant-1',
            incident_status: 'NEEDS_REVIEW',
            incident_version: 4,
          },
        ]),
      )
      .mockResolvedValueOnce(result([locked]))
      .mockResolvedValueOnce(result([approved]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]));
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;

    const repository = new PostgresIncidentReviewRepository(pool);
    await expect(
      repository.approveRevision(approvalInput()),
    ).resolves.toMatchObject({
      id: revisionId,
      status: 'APPROVED',
      approvedBySubject: subject,
    });

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query.mock.calls[1]?.[0]).toEqual(
      expect.stringContaining('JOIN reviewer_memberships membership'),
    );
    expect(query.mock.calls[2]?.[0]).toEqual(
      expect.stringContaining('NOT EXISTS'),
    );
    expect(query.mock.calls[1]?.[1]).toEqual([subject, incidentId]);
    expect(query.mock.calls[2]?.[1]).toEqual([
      'tenant-1',
      incidentId,
      revisionId,
    ]);
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO report_publications'),
      [`publication:${revisionId}`, 'tenant-1', incidentId, revisionId, now],
    );
    expect(query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back every approval write when optimistic incident update loses', async () => {
    const locked = {
      ...revisionRow(),
      incident_status: 'NEEDS_REVIEW',
      incident_version: 4,
      contradiction_count: 0,
      open_question_count: 0,
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([
          {
            tenant_id: 'tenant-1',
            incident_status: 'NEEDS_REVIEW',
            incident_version: 4,
          },
        ]),
      )
      .mockResolvedValueOnce(result([locked]))
      .mockResolvedValueOnce(result([revisionRow('APPROVED')]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([], 0))
      .mockResolvedValueOnce(result([]));
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;

    const repository = new PostgresIncidentReviewRepository(pool);
    await expect(
      repository.approveRevision(approvalInput()),
    ).rejects.toBeInstanceOf(ReviewConflictError);

    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('PostgresIncidentReviewRepository revision persistence', () => {
  it('writes question answers inside the same transaction as the revision', async () => {
    const input: CreateReportRevisionInput = {
      id: revisionId,
      reviewer: { subject },
      incidentId,
      reportDraftId,
      expectedIncidentVersion: 4,
      clientRequestId: 'd61ad8d8-5111-4ce0-a044-1addc5bf0414',
      requestSha256: 'a'.repeat(64),
      acknowledgedContradictions: true,
      acknowledgedOpenQuestions: true,
      questionAnswers: [
        {
          id: 'question-answer-1',
          questionId: 'question-1',
          question: 'Who approved the emergency change?',
          answer: 'The incident commander approved it at 01:14 UTC.',
        },
      ],
      statements: [
        {
          id: 'revision-statement-1',
          originalStatementId: 'statement-1',
          sectionType: 'root_cause',
          position: 0,
          decision: 'KEEP',
          text: 'A pool limit caused request queuing.',
          classification: 'human_confirmed',
          claimIds: [],
          timelineEventIds: [],
        },
      ],
      renderedMarkdown: '# Reviewed',
      contentSha256: 'b'.repeat(64),
      createdAt: now,
      auditEventId: 'audit-event-1',
    };
    const query = vi.fn((sql: string) => {
      if (sql.includes('FOR UPDATE OF i, draft')) {
        return Promise.resolve(
          result([
            {
              tenant_id: 'tenant-1',
              incident_id: incidentId,
              title: 'Checkout outage',
              severity: 'SEV1',
              incident_status: 'NEEDS_REVIEW',
              incident_version: 4,
              incident_created_at: now,
              incident_updated_at: now,
              report_draft_id: reportDraftId,
              draft_version: 1,
              rendered_markdown: '# Draft',
              analysis_run_id: 'analysis-1',
              draft_status: 'NEEDS_REVIEW',
            },
          ]),
        );
      }
      if (sql.includes('COALESCE(MAX(revision_number)')) {
        return Promise.resolve(result([{ next_revision_number: 1 }]));
      }
      if (sql.includes('INSERT INTO report_revisions')) {
        return Promise.resolve(
          result([
            { ...revisionRow(), revision_number: 1, statement_count: 1 },
          ]),
        );
      }
      return Promise.resolve(result([]));
    });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;

    await expect(
      new PostgresIncidentReviewRepository(pool).createRevision(input),
    ).resolves.toMatchObject({ id: revisionId, revisionNumber: 1 });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO report_revision_question_answers'),
      [
        'tenant-1',
        incidentId,
        reportDraftId,
        revisionId,
        ['question-answer-1'],
        ['question-1'],
        ['The incident commander approved it at 01:14 UTC.'],
        now,
      ],
    );
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(query).not.toHaveBeenCalledWith('ROLLBACK');
  });
});

function reviewReadPool(
  revisionStatementRows: readonly QueryResultRow[],
  revisionQuestionAnswerRows: readonly QueryResultRow[] = [],
): {
  readonly pool: Pool;
  readonly query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn((sql: string, parameters?: readonly unknown[]) => {
    if (sql.includes('FROM incidents i')) {
      return Promise.resolve(
        result([
          {
            tenant_id: 'tenant-1',
            incident_id: incidentId,
            title: 'Checkout outage',
            severity: 'SEV1',
            incident_status: 'NEEDS_REVIEW',
            incident_version: 4,
            incident_created_at: now,
            incident_updated_at: now,
            report_draft_id: reportDraftId,
            draft_version: 1,
            rendered_markdown: '# AI draft',
            analysis_run_id: 'analysis-1',
          },
        ]),
      );
    }
    if (sql.includes('FROM incident_report_sections section')) {
      return Promise.resolve(
        result([
          {
            id: 'statement-1',
            section_type: 'ROOT_CAUSE',
            section_position: 0,
            statement_position: 0,
            statement_type: 'CLAIM',
            statement: 'A deploy may have exhausted the connection pool.',
            classification: 'HYPOTHESIS',
            claim_ids: ['claim-1'],
            timeline_event_ids: [],
          },
        ]),
      );
    }
    if (sql.includes('FROM claims claim')) {
      return Promise.resolve(result([]));
    }
    if (sql.includes('FROM timeline_events event')) {
      return Promise.resolve(result([]));
    }
    if (sql.includes('FROM source_artifacts artifact')) {
      return Promise.resolve(result([]));
    }
    if (sql.includes('FROM analysis_open_questions')) {
      return Promise.resolve(result([]));
    }
    if (sql.includes('FROM report_revision_statements')) {
      expect(parameters).toEqual([
        'tenant-1',
        incidentId,
        reportDraftId,
        revisionId,
        301,
      ]);
      return Promise.resolve(result([...revisionStatementRows]));
    }
    if (sql.includes('FROM report_revision_question_answers')) {
      expect(parameters).toEqual([
        'tenant-1',
        incidentId,
        reportDraftId,
        revisionId,
        101,
      ]);
      return Promise.resolve(result([...revisionQuestionAnswerRows]));
    }
    if (sql.includes('FROM report_revisions')) {
      return Promise.resolve(
        result([
          { ...revisionRow(), statement_count: revisionStatementRows.length },
        ]),
      );
    }
    return Promise.reject(new Error(`Unexpected query: ${sql}`));
  });
  return { pool: { query } as unknown as Pool, query };
}

describe('PostgresIncidentReviewRepository review bundle', () => {
  it('loads the complete newest immutable revision using tenant-scoped keys', async () => {
    const { pool, query } = reviewReadPool(
      [
        {
          original_report_statement_id: 'statement-1',
          section_type: 'ROOT_CAUSE',
          position: 0,
          decision: 'EDIT',
          statement: 'The deploy exhausted the database connection pool.',
          classification: 'HUMAN_CONFIRMED',
        },
      ],
      [
        {
          question_id: 'question-1',
          question: 'Who approved the emergency change?',
          answer: 'The incident commander approved it at 01:14 UTC.',
        },
      ],
    );

    const bundle = await new PostgresIncidentReviewRepository(pool).loadBundle(
      { subject },
      incidentId,
    );

    expect(bundle?.latestRevision).toMatchObject({
      id: revisionId,
      revisionNumber: 2,
      status: 'DRAFT',
      statements: [
        {
          originalStatementId: 'statement-1',
          sectionType: 'root_cause',
          position: 0,
          decision: 'EDIT',
          text: 'The deploy exhausted the database connection pool.',
          classification: 'human_confirmed',
        },
      ],
      questionAnswers: [
        {
          questionId: 'question-1',
          question: 'Who approved the emergency change?',
          answer: 'The incident commander approved it at 01:14 UTC.',
        },
      ],
    });
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      subject,
      incidentId,
    ]);
  });

  it('rejects an incomplete immutable revision instead of displaying it', async () => {
    const { pool } = reviewReadPool([]);

    await expect(
      new PostgresIncidentReviewRepository(pool).loadBundle(
        { subject },
        incidentId,
      ),
    ).rejects.toBeInstanceOf(ReviewConfigurationError);
  });
});

describe('PostgresIncidentReviewRepository revision history', () => {
  it('loads an older revision only through an active tenant membership', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(
        result([
          {
            ...revisionRow('APPROVED'),
            statement_count: 1,
            source_statement_count: '2',
          },
        ]),
      )
      .mockResolvedValueOnce(
        result([
          {
            original_report_statement_id: 'statement-1',
            section_type: 'ROOT_CAUSE',
            position: 0,
            decision: 'KEEP',
            statement: 'A pool limit caused request queuing.',
            classification: 'HUMAN_CONFIRMED',
          },
          {
            original_report_statement_id: 'statement-2',
            section_type: 'CONTRIBUTING_FACTORS',
            position: 0,
            decision: 'EXCLUDE',
            statement: null,
            classification: null,
          },
        ]),
      )
      .mockResolvedValueOnce(result([]));
    const pool = { query } as unknown as Pool;

    await expect(
      new PostgresIncidentReviewRepository(pool).loadRevision(
        { subject },
        incidentId,
        revisionId,
      ),
    ).resolves.toMatchObject({
      id: revisionId,
      statementCount: 1,
      statements: [
        { originalStatementId: 'statement-1', decision: 'KEEP' },
        { originalStatementId: 'statement-2', decision: 'EXCLUDE' },
      ],
    });
    expect(query.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('JOIN reviewer_memberships membership'),
    );
    expect(query.mock.calls[0]?.[1]).toEqual([subject, incidentId, revisionId]);
  });
});
