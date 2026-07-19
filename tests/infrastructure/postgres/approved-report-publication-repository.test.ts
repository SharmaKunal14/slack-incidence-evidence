import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresApprovedReportPublicationRepository } from '../../../src/infrastructure/postgres/approved-report-publication-repository.js';

function result<Row extends QueryResultRow>(
  rows: Row[],
  rowCount = rows.length,
): QueryResult<Row> {
  return { command: '', fields: [], oid: 0, rowCount, rows };
}

const claimedAt = new Date('2026-07-19T01:00:00.000Z');
const leaseExpiresAt = new Date('2026-07-19T01:03:00.000Z');
const incidentId = '2c6a2f4a-f762-41e9-9620-a07abdaa5c48';
const revisionId = '617b5728-8404-4934-a616-1a319ba72b7f';
const jobId = `publication:${revisionId}`;

describe('PostgresApprovedReportPublicationRepository', () => {
  it('terminally records an abandoned final lease instead of orphaning it', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ id: jobId }]))
      .mockResolvedValueOnce(result([]));
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;

    await expect(
      new PostgresApprovedReportPublicationRepository(pool).claimNext({
        workerId: 'event-id',
        claimedAt,
        leaseExpiresAt,
        maxAttempts: 8,
        publisher: 'CONFLUENCE',
      }),
    ).rejects.toThrow('abandoned publication leases exhausted retries');
    expect(query.mock.calls[1]?.[0]).toEqual(
      expect.stringContaining(
        "last_error_code = 'PUBLICATION_LEASE_EXHAUSTED'",
      ),
    );
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('claims one due job with SKIP LOCKED and loads only approved content', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ id: jobId }]))
      .mockResolvedValueOnce(
        result([
          {
            id: jobId,
            tenant_id: 'T001',
            incident_id: incidentId,
            report_revision_id: revisionId,
            status: 'PENDING',
            attempt_count: 1,
            publisher: 'CONFLUENCE',
            published_page_id: null,
            published_page_url: null,
            title: 'Checkout outage',
            severity: 'SEV1',
            source_workspace_id: 'T001',
            source_channel_id: 'C001',
            source_message_ts: '1721178000.000100',
            source_thread_ts: null,
            revision_number: 2,
            approved_at: claimedAt,
            statement_count: 1,
          },
        ]),
      )
      .mockResolvedValueOnce(
        result([
          {
            section_type: 'ROOT_CAUSE',
            position: 0,
            statement: 'A pool limit caused request queuing.',
            classification: 'HUMAN_CONFIRMED',
          },
        ]),
      )
      .mockResolvedValueOnce(result([]));
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;

    await expect(
      new PostgresApprovedReportPublicationRepository(pool).claimNext({
        workerId: 'event-id',
        claimedAt,
        leaseExpiresAt,
        maxAttempts: 8,
        publisher: 'CONFLUENCE',
      }),
    ).resolves.toMatchObject({
      id: jobId,
      attemptCount: 1,
      publisher: 'CONFLUENCE',
      threadTs: '1721178000.000100',
      document: {
        title: 'Checkout outage',
        revisionNumber: 2,
        sections: [
          {
            sectionType: 'root_cause',
            statements: [
              {
                text: 'A pool limit caused request queuing.',
                classification: 'human_confirmed',
              },
            ],
          },
        ],
      },
    });
    expect(query.mock.calls[2]?.[0]).toEqual(
      expect.stringContaining('FOR UPDATE SKIP LOCKED'),
    );
    expect(query.mock.calls[2]?.[1]).toContain('CONFLUENCE');
    expect(query.mock.calls[3]?.[0]).toEqual(
      expect.stringContaining("incident.status = 'APPROVED'"),
    );
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('requires the active lease and assigned provider when checkpointing a page', async () => {
    const query = vi.fn().mockResolvedValue(result([], 0));
    const pool = { query } as unknown as Pool;

    await expect(
      new PostgresApprovedReportPublicationRepository(pool).markPagePublished({
        jobId,
        workerId: 'stale-worker',
        publisher: 'CONFLUENCE',
        pageId: '12345678-1234-1234-1234-123456789abc',
        pageUrl:
          'https://www.notion.so/Report-12345678123412341234123456789abc',
        publishedAt: claimedAt,
      }),
    ).rejects.toThrow('lost its lease');
    expect(query.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('lease_expires_at > $3'),
    );
  });
});
