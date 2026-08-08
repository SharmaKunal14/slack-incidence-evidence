import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  ReviewConflictError,
  ReviewNotFoundError,
} from '../../../src/application/review/incident-review.js';
import { PostgresIncidentReviewRepository } from '../../../src/infrastructure/postgres/incident-review-repository.js';

function result<Row extends QueryResultRow>(
  rows: Row[],
  rowCount = rows.length,
): QueryResult<Row> {
  return { command: '', fields: [], oid: 0, rowCount, rows };
}

const input = {
  auditEventId: '96a8f3e2-a9f7-46c8-a5ef-28a8cb69d2a4',
  reviewer: { subject: 'owner-subject' },
  incidentId: '2c6a2f4a-f762-41e9-9620-a07abdaa5c48',
  expectedIncidentVersion: 4,
  memberSubject: 'reviewer-subject',
  clientRequestId: 'd61ad8d8-5111-4ce0-a044-1addc5bf0414',
  assignedAt: new Date('2026-08-08T06:00:00.000Z'),
} as const;

function repository(query: ReturnType<typeof vi.fn>): {
  readonly repository: PostgresIncidentReviewRepository;
  readonly release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  return {
    repository: new PostgresIncidentReviewRepository({
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool),
    release,
  };
}

describe('PostgresIncidentReviewRepository reviewer assignment', () => {
  it('lets an active workspace administrator assign an eligible member atomically', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([
          {
            tenant_id: 'T001',
            status: 'NEEDS_REVIEW',
            version: 4,
            assigned_reviewer_subject: null,
          },
        ]),
      )
      .mockResolvedValueOnce(result([{ slack_user_id: 'U002' }]))
      .mockResolvedValueOnce(
        result([{ version: 5, updated_at: input.assignedAt }]),
      )
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([]));
    const connected = repository(query);

    await expect(connected.repository.assignReviewer(input)).resolves.toEqual({
      incidentId: input.incidentId,
      workspaceId: 'T001',
      assignedMemberSubject: 'reviewer-subject',
      assignedSlackUserId: 'U002',
      incidentVersion: 5,
      updatedAt: input.assignedAt.toISOString(),
    });

    expect(String(query.mock.calls[1]?.[0])).toContain(
      "actor.role IN ('OWNER', 'ADMIN')",
    );
    expect(String(query.mock.calls[2]?.[0])).toContain(
      "role IN ('OWNER', 'ADMIN', 'REVIEWER')",
    );
    expect(query.mock.calls[2]?.[1]).toEqual(['T001', 'reviewer-subject']);
    expect(String(query.mock.calls[4]?.[0])).toContain(
      'INSERT INTO audit_events',
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(connected.release).toHaveBeenCalledOnce();
  });

  it('fails closed when the caller is not an active Owner or Admin', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]));
    const connected = repository(query);

    await expect(
      connected.repository.assignReviewer(input),
    ).rejects.toBeInstanceOf(ReviewNotFoundError);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('rejects stale assignment updates before changing the incident', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([
          {
            tenant_id: 'T001',
            status: 'NEEDS_REVIEW',
            version: 5,
            assigned_reviewer_subject: null,
          },
        ]),
      )
      .mockResolvedValueOnce(result([]));
    const connected = repository(query);

    await expect(
      connected.repository.assignReviewer(input),
    ).rejects.toBeInstanceOf(ReviewConflictError);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
