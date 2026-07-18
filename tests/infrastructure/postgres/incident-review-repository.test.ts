import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { ReviewConflictError } from '../../../src/application/review/incident-review.js';
import type { ApproveReportRevisionInput } from '../../../src/application/ports/incident-review-repository.js';
import { PostgresIncidentReviewRepository } from '../../../src/infrastructure/postgres/incident-review-repository.js';

const now = new Date('2026-07-18T01:00:00.000Z');
const incidentId = '2c6a2f4a-f762-41e9-9620-a07abdaa5c48';
const revisionId = '617b5728-8404-4934-a616-1a319ba72b7f';
const subject = '9f218e92-36a8-455d-869c-a76e27b399df';

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
    report_draft_id: '7df1bcac-5583-4cd6-91db-981989f4c482',
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
