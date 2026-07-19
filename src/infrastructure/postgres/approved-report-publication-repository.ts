import type { Pool, PoolClient } from 'pg';
import type {
  ApprovedReportPublicationJob,
  ApprovedReportPublicationRepository,
  ApprovedReportPublicationStatus,
} from '../../application/ports/approved-report-publication-repository.js';
import type { ApprovedReportPublicationSection } from '../../application/ports/approved-report-publisher.js';
import type { ReportPublicationProvider } from '../../application/ports/approved-report-publisher.js';
import {
  parseReviewClassification,
  parseSectionType,
} from '../../application/review/incident-review.js';

const MAX_PUBLICATION_STATEMENTS = 300;
const MAX_PUBLICATION_OPEN_QUESTIONS = 100;

interface PublicationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly incident_id: string;
  readonly report_revision_id: string;
  readonly status: ApprovedReportPublicationStatus;
  readonly attempt_count: number;
  readonly publisher: ReportPublicationProvider | null;
  readonly published_page_id: string | null;
  readonly published_page_url: string | null;
  readonly title: string;
  readonly severity: string;
  readonly source_workspace_id: string;
  readonly source_channel_id: string;
  readonly source_message_ts: string | null;
  readonly source_thread_ts: string | null;
  readonly revision_number: number;
  readonly approved_at: Date | string | null;
  readonly statement_count: number;
}

interface PublicationStatementRow {
  readonly section_type: string;
  readonly position: number;
  readonly statement: string | null;
  readonly classification: string | null;
}

interface PublicationQuestionAnswerRow {
  readonly question: string;
  readonly answer: string | null;
}

/** Leases due publication jobs and checkpoints each external side effect. */
export class PostgresApprovedReportPublicationRepository implements ApprovedReportPublicationRepository {
  public constructor(private readonly pool: Pool) {}

  public async claimNext(input: {
    readonly workerId: string;
    readonly claimedAt: Date;
    readonly leaseExpiresAt: Date;
    readonly maxAttempts: number;
    readonly publisher: ReportPublicationProvider;
  }): Promise<ApprovedReportPublicationJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const exhausted = await client.query<{ readonly id: string }>(
        `
          UPDATE report_publications
          SET status = 'FAILED',
              last_error_code = 'PUBLICATION_LEASE_EXHAUSTED',
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = $1,
              failed_at = $1
          WHERE status IN ('PENDING', 'PAGE_PUBLISHED')
            AND attempt_count >= $2
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= $1
          RETURNING id
        `,
        [input.claimedAt, input.maxAttempts],
      );
      if (exhausted.rows.length > 0) {
        await client.query('COMMIT');
        throw new PublicationAttemptsExhaustedError();
      }
      const claimed = await client.query<{ readonly id: string }>(
        `
          WITH candidate AS (
            SELECT publication.id
            FROM report_publications publication
            WHERE (
                publication.status = 'PAGE_PUBLISHED'
                OR (
                  publication.status = 'PENDING'
                  AND (
                    publication.publisher IS NULL
                    OR publication.publisher = $5
                  )
                )
              )
              AND publication.next_attempt_at <= $1
              AND (
                publication.lease_expires_at IS NULL
                OR publication.lease_expires_at <= $1
              )
              AND publication.attempt_count < $4
            ORDER BY publication.next_attempt_at, publication.created_at, publication.id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE report_publications publication
          SET attempt_count = publication.attempt_count + 1,
              publisher = COALESCE(publication.publisher, $5),
              lease_owner = $2,
              lease_expires_at = $3,
              updated_at = $1
          FROM candidate
          WHERE publication.id = candidate.id
          RETURNING publication.id
        `,
        [
          input.claimedAt,
          input.workerId,
          input.leaseExpiresAt,
          input.maxAttempts,
          input.publisher,
        ],
      );
      const jobId = claimed.rows[0]?.id;
      if (jobId === undefined) {
        await client.query('COMMIT');
        return null;
      }

      const job = await loadPublication(client, jobId, input.workerId);
      await client.query('COMMIT');
      return job;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async markPagePublished(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly publisher: ReportPublicationProvider;
    readonly pageId: string;
    readonly pageUrl: string;
    readonly publishedAt: Date;
  }): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE report_publications
        SET status = 'PAGE_PUBLISHED',
            published_page_id = $1,
            published_page_url = $2,
            last_error_code = NULL,
            updated_at = $3
        WHERE id = $4
          AND lease_owner = $5
          AND lease_expires_at > $3
          AND status = 'PENDING'
          AND publisher = $6
      `,
      [
        input.pageId,
        input.pageUrl,
        input.publishedAt,
        input.jobId,
        input.workerId,
        input.publisher,
      ],
    );
    requireUpdated(result.rowCount, 'Page publication checkpoint');
  }

  public async markComplete(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly slackMessageTs: string;
    readonly completedAt: Date;
  }): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE report_publications
        SET status = 'COMPLETE',
            slack_message_ts = $1,
            last_error_code = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = $2,
            completed_at = $2,
            failed_at = NULL
        WHERE id = $3
          AND lease_owner = $4
          AND lease_expires_at > $2
          AND status = 'PAGE_PUBLISHED'
      `,
      [input.slackMessageTs, input.completedAt, input.jobId, input.workerId],
    );
    requireUpdated(result.rowCount, 'Slack publication checkpoint');
  }

  public async recordFailure(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly errorCode: string;
    readonly retryAt: Date;
    readonly failedAt: Date;
    readonly terminal: boolean;
  }): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE report_publications
        SET status = CASE WHEN $1::boolean THEN 'FAILED' ELSE status END,
            next_attempt_at = $2::timestamptz,
            last_error_code = $3,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = $4::timestamptz,
            failed_at = CASE
              WHEN $1::boolean THEN $4::timestamptz
              ELSE NULL::timestamptz
            END
        WHERE id = $5
          AND lease_owner = $6
          AND status IN ('PENDING', 'PAGE_PUBLISHED')
      `,
      [
        input.terminal,
        input.retryAt,
        input.errorCode,
        input.failedAt,
        input.jobId,
        input.workerId,
      ],
    );
    requireUpdated(result.rowCount, 'Publication failure checkpoint');
  }
}

async function loadPublication(
  client: PoolClient,
  jobId: string,
  workerId: string,
): Promise<ApprovedReportPublicationJob> {
  const result = await client.query<PublicationRow>(
    `
      SELECT
        publication.id,
        publication.tenant_id,
        publication.incident_id,
        publication.report_revision_id,
        publication.status,
        publication.attempt_count,
        publication.publisher,
        publication.published_page_id,
        publication.published_page_url,
        incident.title,
        incident.severity,
        incident.source_workspace_id,
        incident.source_channel_id,
        incident.source_message_ts,
        incident.source_thread_ts,
        revision.revision_number,
        revision.approved_at,
        revision.statement_count
      FROM report_publications publication
      JOIN incidents incident
        ON incident.tenant_id = publication.tenant_id
       AND incident.id = publication.incident_id
       AND incident.status = 'APPROVED'
      JOIN report_revisions revision
        ON revision.tenant_id = publication.tenant_id
       AND revision.incident_id = publication.incident_id
       AND revision.id = publication.report_revision_id
       AND revision.status = 'APPROVED'
      WHERE publication.id = $1
        AND publication.lease_owner = $2
      LIMIT 1
    `,
    [jobId, workerId],
  );
  const row = result.rows[0];
  if (row === undefined || row.approved_at === null) {
    throw new PublicationPersistenceError(
      'Publication job does not reference an approved revision',
    );
  }
  const threadTs = row.source_thread_ts ?? row.source_message_ts;
  if (threadTs === null) {
    throw new PublicationPersistenceError(
      'Approved incident has no Slack notification destination',
    );
  }

  const statementResult = await client.query<PublicationStatementRow>(
    `
      SELECT section_type, position, statement, classification
      FROM report_revision_statements
      WHERE tenant_id = $1
        AND incident_id = $2
        AND report_revision_id = $3
        AND decision <> 'EXCLUDE'
      ORDER BY section_type, position, id
      LIMIT $4
    `,
    [
      row.tenant_id,
      row.incident_id,
      row.report_revision_id,
      MAX_PUBLICATION_STATEMENTS + 1,
    ],
  );
  if (
    statementResult.rows.length > MAX_PUBLICATION_STATEMENTS ||
    statementResult.rows.length !== row.statement_count
  ) {
    throw new PublicationPersistenceError(
      'Approved revision statement count is inconsistent',
    );
  }

  const questionResult = await client.query<PublicationQuestionAnswerRow>(
    `
        SELECT question.question, answer.answer
        FROM report_revisions revision
        JOIN incident_report_drafts draft
          ON draft.tenant_id = revision.tenant_id
         AND draft.incident_id = revision.incident_id
         AND draft.id = revision.report_draft_id
        JOIN analysis_open_questions question
          ON question.tenant_id = draft.tenant_id
         AND question.incident_id = draft.incident_id
         AND question.analysis_run_id = draft.analysis_run_id
        LEFT JOIN report_revision_question_answers answer
          ON answer.tenant_id = revision.tenant_id
         AND answer.incident_id = revision.incident_id
         AND answer.report_revision_id = revision.id
         AND answer.question_id = question.id
        WHERE revision.tenant_id = $1
          AND revision.incident_id = $2
          AND revision.id = $3
        ORDER BY question.created_at, question.id
        LIMIT $4
      `,
    [
      row.tenant_id,
      row.incident_id,
      row.report_revision_id,
      MAX_PUBLICATION_OPEN_QUESTIONS + 1,
    ],
  );
  if (questionResult.rows.length > MAX_PUBLICATION_OPEN_QUESTIONS) {
    throw new PublicationPersistenceError(
      'Approved revision open questions exceed the publication limit',
    );
  }
  const questionAnswers = questionResult.rows.flatMap((question) =>
    question.answer === null
      ? []
      : [{ question: question.question, answer: question.answer }],
  );
  const remainingOpenQuestions = questionResult.rows.flatMap((question) =>
    question.answer === null ? [question.question] : [],
  );

  return {
    id: row.id,
    tenantId: row.tenant_id,
    incidentId: row.incident_id,
    revisionId: row.report_revision_id,
    status: row.status,
    attemptCount: row.attempt_count,
    publisher: row.publisher,
    publishedPageId: row.published_page_id,
    publishedPageUrl: row.published_page_url,
    workspaceId: row.source_workspace_id,
    channelId: row.source_channel_id,
    threadTs,
    document: {
      incidentId: row.incident_id,
      title: row.title,
      severity: row.severity,
      revisionNumber: positiveInteger(row.revision_number, 'revision number'),
      approvedAt: toDate(row.approved_at),
      sections: toSections(statementResult.rows),
      questionAnswers,
      remainingOpenQuestions,
    },
  };
}

function toSections(
  rows: readonly PublicationStatementRow[],
): readonly ApprovedReportPublicationSection[] {
  const sections = new Map<
    ApprovedReportPublicationSection['sectionType'],
    ApprovedReportPublicationSection['statements'][number][]
  >();
  for (const row of rows) {
    if (row.statement === null || row.classification === null) {
      throw new PublicationPersistenceError(
        'Included publication statement has no content',
      );
    }
    const sectionType = parseSectionType(row.section_type);
    const statements = sections.get(sectionType) ?? [];
    statements.push({
      text: row.statement,
      classification: parseReviewClassification(row.classification),
    });
    sections.set(sectionType, statements);
  }
  return [...sections].map(([sectionType, statements]) => ({
    sectionType,
    statements,
  }));
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1) {
    throw new PublicationPersistenceError(`Invalid ${name}`);
  }
  return parsed as number;
}

function toDate(value: Date | string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new PublicationPersistenceError('Invalid publication timestamp');
  }
  return parsed;
}

function requireUpdated(rowCount: number | null, operation: string): void {
  if (rowCount !== 1) {
    throw new PublicationPersistenceError(`${operation} lost its lease`);
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original query or validation error.
  }
}

export class PublicationPersistenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PublicationPersistenceError';
  }
}

export class PublicationAttemptsExhaustedError extends Error {
  public constructor() {
    super('One or more abandoned publication leases exhausted retries');
    this.name = 'PublicationAttemptsExhaustedError';
  }
}
