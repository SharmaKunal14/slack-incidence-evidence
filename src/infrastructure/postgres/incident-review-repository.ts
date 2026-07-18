import type { Pool, PoolClient, QueryResult } from 'pg';
import {
  ReviewConfigurationError,
  ReviewConflictError,
  ReviewNotFoundError,
  parseReviewClassification,
  parseSectionType,
  type IncidentReviewBundle,
  type ReportRevision,
  type ReportRevisionSummary,
  type ReviewClaim,
  type ReviewEvidence,
  type ReviewInboxCursor,
  type ReviewInboxItem,
  type ReviewReportSection,
  type ReviewReportStatement,
  type ReviewTimelineEvent,
  type ReviewerIdentity,
} from '../../application/review/incident-review.js';
import type {
  ApproveReportRevisionInput,
  CreateReportRevisionInput,
  IncidentReviewRepository,
} from '../../application/ports/incident-review-repository.js';

const MAX_REPORT_STATEMENTS = 300;
const MAX_CLAIMS = 200;
const MAX_TIMELINE_EVENTS = 200;
const MAX_EVIDENCE = 200;
const MAX_OPEN_QUESTIONS = 100;

interface InboxRow {
  readonly incident_id: string;
  readonly title: string;
  readonly severity: string;
  readonly status: 'NEEDS_REVIEW' | 'APPROVED';
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly incident_version: number;
  readonly report_draft_id: string;
  readonly input_claim_count: number;
  readonly input_timeline_event_count: number;
  readonly input_open_question_count: number;
  readonly contradiction_count: number | string;
  readonly latest_revision_id: string | null;
  readonly latest_revision_number: number | null;
  readonly latest_revision_status: 'DRAFT' | 'APPROVED' | null;
}

interface BundleHeaderRow {
  readonly tenant_id: string;
  readonly incident_id: string;
  readonly title: string;
  readonly severity: string;
  readonly incident_status: 'NEEDS_REVIEW' | 'APPROVED';
  readonly incident_version: number;
  readonly incident_created_at: Date | string;
  readonly incident_updated_at: Date | string;
  readonly report_draft_id: string;
  readonly draft_version: number;
  readonly rendered_markdown: string;
  readonly analysis_run_id: string;
}

interface StatementRow {
  readonly id: string;
  readonly section_type: string;
  readonly section_position: number;
  readonly statement_position: number;
  readonly statement_type: 'CLAIM' | 'TIMELINE';
  readonly statement: string;
  readonly classification: string;
  readonly claim_ids: string[] | null;
  readonly timeline_event_ids: string[] | null;
}

interface ClaimRow {
  readonly id: string;
  readonly statement: string;
  readonly classification: string;
  readonly review_status: string;
  readonly supporting_evidence_ids: string[] | null;
  readonly contradicting_evidence_ids: string[] | null;
}

interface TimelineRow {
  readonly id: string;
  readonly event_time: Date | string;
  readonly summary: string;
  readonly classification: string;
  readonly evidence_ids: string[] | null;
}

interface EvidenceRow {
  readonly id: string;
  readonly source_type: string;
  readonly occurred_at: Date | string;
  readonly author_external_id: string | null;
  readonly content: string;
  readonly content_truncated: boolean;
  readonly source_uri: string | null;
}

interface QuestionRow {
  readonly id: string;
  readonly question: string;
}

interface RevisionRow {
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
  readonly created_at: Date | string;
  readonly approved_by_subject: string | null;
  readonly approved_at: Date | string | null;
}

interface LockedReviewRow extends BundleHeaderRow {
  readonly draft_status: string;
}

interface LockedIncidentApprovalRow {
  readonly tenant_id: string;
  readonly incident_status: 'NEEDS_REVIEW' | 'APPROVED';
  readonly incident_version: number;
}

const REVISION_COLUMNS = `
  id,
  tenant_id,
  incident_id,
  report_draft_id,
  revision_number,
  status,
  created_by_subject,
  request_sha256,
  acknowledged_contradictions,
  acknowledged_open_questions,
  statement_count,
  rendered_markdown,
  content_sha256,
  created_at,
  approved_by_subject,
  approved_at
`;

/** Tenant-authorized read model and transactional human review persistence. */
export class PostgresIncidentReviewRepository implements IncidentReviewRepository {
  public constructor(private readonly pool: Pool) {}

  public async listInbox(
    reviewer: ReviewerIdentity,
    limit: number,
    cursor: ReviewInboxCursor | null,
  ): Promise<{
    readonly authorized: boolean;
    readonly page: {
      readonly items: readonly ReviewInboxItem[];
      readonly nextCursor: ReviewInboxCursor | null;
    };
  }> {
    const membership = await this.pool.query<{ readonly authorized: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM reviewer_memberships
          WHERE cognito_subject = $1
            AND status = 'ACTIVE'
        ) AS authorized
      `,
      [reviewer.subject],
    );
    if (membership.rows[0]?.authorized !== true) {
      return { authorized: false, page: { items: [], nextCursor: null } };
    }

    const result = await this.pool.query<InboxRow>(
      `
        SELECT
          i.id AS incident_id,
          i.title,
          i.severity,
          i.status,
          i.created_at,
          i.updated_at,
          i.version AS incident_version,
          d.id AS report_draft_id,
          d.input_claim_count,
          d.input_timeline_event_count,
          d.input_open_question_count,
          (
            SELECT COUNT(*)
            FROM claims c
            WHERE c.tenant_id = i.tenant_id
              AND c.incident_id = i.id
              AND c.analysis_run_id = d.analysis_run_id
              AND (
                c.classification = 'DISPUTED'
                OR EXISTS (
                  SELECT 1
                  FROM claim_evidence_links cel
                  WHERE cel.tenant_id = c.tenant_id
                    AND cel.incident_id = c.incident_id
                    AND cel.claim_id = c.id
                    AND cel.relationship = 'CONTRADICTS'
                )
              )
          ) AS contradiction_count,
          revision.id AS latest_revision_id,
          revision.revision_number AS latest_revision_number,
          revision.status AS latest_revision_status
        FROM incidents i
        JOIN reviewer_memberships membership
          ON membership.tenant_id = i.tenant_id
         AND membership.cognito_subject = $1
         AND membership.status = 'ACTIVE'
        JOIN LATERAL (
          SELECT candidate.*
          FROM incident_report_drafts candidate
          WHERE candidate.tenant_id = i.tenant_id
            AND candidate.incident_id = i.id
            AND candidate.status = 'NEEDS_REVIEW'
          ORDER BY candidate.draft_version DESC
          LIMIT 1
        ) d ON TRUE
        LEFT JOIN LATERAL (
          SELECT candidate.id, candidate.revision_number, candidate.status
          FROM report_revisions candidate
          WHERE candidate.tenant_id = i.tenant_id
            AND candidate.incident_id = i.id
            AND candidate.report_draft_id = d.id
          ORDER BY candidate.revision_number DESC
          LIMIT 1
        ) revision ON TRUE
        WHERE i.status IN ('NEEDS_REVIEW', 'APPROVED')
          AND (
            $2::timestamptz IS NULL
            OR (i.created_at, i.id) < ($2::timestamptz, $3::text)
          )
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT $4
      `,
      [
        reviewer.subject,
        cursor?.createdAt ?? null,
        cursor?.incidentId ?? null,
        limit + 1,
      ],
    );
    const hasNext = result.rows.length > limit;
    const visibleRows = result.rows.slice(0, limit);
    const items = visibleRows.map(toInboxItem);
    const last = visibleRows.at(-1);
    return {
      authorized: true,
      page: {
        items,
        nextCursor:
          hasNext && last !== undefined
            ? {
                createdAt: toIsoString(last.created_at),
                incidentId: last.incident_id,
              }
            : null,
      },
    };
  }

  public async loadBundle(
    reviewer: ReviewerIdentity,
    incidentId: string,
  ): Promise<IncidentReviewBundle | null> {
    const headerResult = await this.pool.query<BundleHeaderRow>(
      `
        SELECT
          i.tenant_id,
          i.id AS incident_id,
          i.title,
          i.severity,
          i.status AS incident_status,
          i.version AS incident_version,
          i.created_at AS incident_created_at,
          i.updated_at AS incident_updated_at,
          d.id AS report_draft_id,
          d.draft_version,
          d.rendered_markdown,
          d.analysis_run_id
        FROM incidents i
        JOIN reviewer_memberships membership
          ON membership.tenant_id = i.tenant_id
         AND membership.cognito_subject = $1
         AND membership.status = 'ACTIVE'
        JOIN LATERAL (
          SELECT candidate.*
          FROM incident_report_drafts candidate
          WHERE candidate.tenant_id = i.tenant_id
            AND candidate.incident_id = i.id
            AND candidate.status = 'NEEDS_REVIEW'
          ORDER BY candidate.draft_version DESC
          LIMIT 1
        ) d ON TRUE
        WHERE i.id = $2
          AND i.status IN ('NEEDS_REVIEW', 'APPROVED')
        LIMIT 1
      `,
      [reviewer.subject, incidentId],
    );
    const header = headerResult.rows[0];
    if (header === undefined) {
      return null;
    }

    const [
      statementResult,
      claimResult,
      timelineResult,
      evidenceResult,
      questionResult,
      revisionResult,
    ] = await Promise.all([
      this.loadStatements(header),
      this.loadClaims(header),
      this.loadTimeline(header),
      this.loadEvidence(header),
      this.loadQuestions(header),
      this.loadRevisions(header),
    ]);
    requireBound(
      statementResult.rows,
      MAX_REPORT_STATEMENTS,
      'report statements',
    );
    requireBound(claimResult.rows, MAX_CLAIMS, 'claims');
    requireBound(timelineResult.rows, MAX_TIMELINE_EVENTS, 'timeline events');
    requireBound(evidenceResult.rows, MAX_EVIDENCE, 'evidence artifacts');
    requireBound(questionResult.rows, MAX_OPEN_QUESTIONS, 'open questions');

    return {
      incident: {
        id: header.incident_id,
        title: header.title,
        severity: header.severity,
        status: header.incident_status,
        version: header.incident_version,
        createdAt: toIsoString(header.incident_created_at),
        updatedAt: toIsoString(header.incident_updated_at),
      },
      reportDraft: {
        id: header.report_draft_id,
        draftVersion: header.draft_version,
        renderedMarkdown: header.rendered_markdown,
      },
      sections: toSections(statementResult.rows),
      claims: claimResult.rows.map(toClaim),
      timeline: timelineResult.rows.map(toTimelineEvent),
      evidence: evidenceResult.rows.map(toEvidence),
      openQuestions: questionResult.rows,
      revisions: revisionResult.rows.map(toRevisionSummary),
    };
  }

  public async createRevision(
    input: CreateReportRevisionInput,
  ): Promise<ReportRevision> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await lockReviewContext(
        client,
        input.reviewer,
        input.incidentId,
        input.reportDraftId,
      );
      if (
        locked.incident_status !== 'NEEDS_REVIEW' ||
        locked.draft_status !== 'NEEDS_REVIEW'
      ) {
        throw new ReviewConflictError('Incident is not awaiting review');
      }
      if (locked.incident_version !== input.expectedIncidentVersion) {
        throw new ReviewConflictError();
      }

      const revisionNumberResult = await client.query<{
        readonly next_revision_number: number;
      }>(
        `
          SELECT COALESCE(MAX(revision_number), 0) + 1 AS next_revision_number
          FROM report_revisions
          WHERE tenant_id = $1
            AND incident_id = $2
            AND report_draft_id = $3
        `,
        [locked.tenant_id, input.incidentId, input.reportDraftId],
      );
      const revisionNumber = parsePositiveInteger(
        revisionNumberResult.rows[0]?.next_revision_number,
        'revision number',
      );
      const inserted = await client.query<RevisionRow>(
        `
          INSERT INTO report_revisions (
            id,
            tenant_id,
            incident_id,
            report_draft_id,
            revision_number,
            status,
            created_by_subject,
            client_request_id,
            request_sha256,
            acknowledged_contradictions,
            acknowledged_open_questions,
            statement_count,
            rendered_markdown,
            content_sha256,
            created_at
          )
          VALUES (
            $1, $2, $3, $4, $5, 'DRAFT', $6, $7, $8, $9, $10, $11, $12, $13, $14
          )
          ON CONFLICT (tenant_id, created_by_subject, client_request_id)
          DO NOTHING
          RETURNING ${REVISION_COLUMNS}
        `,
        [
          input.id,
          locked.tenant_id,
          input.incidentId,
          input.reportDraftId,
          revisionNumber,
          input.reviewer.subject,
          input.clientRequestId,
          input.requestSha256,
          input.acknowledgedContradictions,
          input.acknowledgedOpenQuestions,
          input.statements.filter(
            (statement) => statement.decision !== 'EXCLUDE',
          ).length,
          input.renderedMarkdown,
          input.contentSha256,
          input.createdAt,
        ],
      );
      const created = inserted.rows[0];
      if (created === undefined) {
        const existing = await findRevisionByRequest(
          client,
          locked.tenant_id,
          input.reviewer.subject,
          input.clientRequestId,
        );
        if (
          existing.request_sha256 !== input.requestSha256 ||
          existing.incident_id !== input.incidentId ||
          existing.report_draft_id !== input.reportDraftId
        ) {
          throw new ReviewConflictError(
            'Idempotency key was reused for different review content',
          );
        }
        await client.query('COMMIT');
        return toRevision(existing);
      }

      await insertRevisionStatements(client, locked.tenant_id, input);
      await insertAuditEvent(client, {
        id: input.auditEventId,
        tenantId: locked.tenant_id,
        incidentId: input.incidentId,
        actorId: input.reviewer.subject,
        action: 'REPORT_REVISION_CREATED',
        targetType: 'REPORT_REVISION',
        targetId: created.id,
        requestId: input.clientRequestId,
        metadata: {
          revisionNumber,
          includedStatementCount: created.statement_count,
        },
        occurredAt: input.createdAt,
      });
      await client.query('COMMIT');
      return toRevision(created);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async approveRevision(
    input: ApproveReportRevisionInput,
  ): Promise<ReportRevision> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Every review mutation locks the incident first. The subsequent query
      // therefore sees any revision committed by a concurrent creator before
      // deciding which revision is newest and approvable.
      const incidentResult = await client.query<LockedIncidentApprovalRow>(
        `
          SELECT
            i.tenant_id,
            i.status AS incident_status,
            i.version AS incident_version
          FROM incidents i
          JOIN reviewer_memberships membership
            ON membership.tenant_id = i.tenant_id
           AND membership.cognito_subject = $1
           AND membership.status = 'ACTIVE'
           AND membership.role IN ('REVIEWER', 'ADMIN')
          WHERE i.id = $2
          FOR UPDATE OF i
        `,
        [input.reviewer.subject, input.incidentId],
      );
      const lockedIncident = incidentResult.rows[0];
      if (lockedIncident === undefined) {
        throw new ReviewNotFoundError();
      }

      const result = await client.query<
        RevisionRow & {
          readonly contradiction_count: number | string;
          readonly open_question_count: number;
        }
      >(
        `
          SELECT
            revision.*,
            draft.input_open_question_count AS open_question_count,
            (
              SELECT COUNT(*)
              FROM claims c
              WHERE c.tenant_id = revision.tenant_id
                AND c.incident_id = revision.incident_id
                AND c.analysis_run_id = draft.analysis_run_id
                AND (
                  c.classification = 'DISPUTED'
                  OR EXISTS (
                    SELECT 1
                    FROM claim_evidence_links link
                    WHERE link.tenant_id = c.tenant_id
                      AND link.incident_id = c.incident_id
                      AND link.claim_id = c.id
                      AND link.relationship = 'CONTRADICTS'
                  )
                )
            ) AS contradiction_count
          FROM report_revisions revision
          JOIN incident_report_drafts draft
            ON draft.tenant_id = revision.tenant_id
           AND draft.incident_id = revision.incident_id
           AND draft.id = revision.report_draft_id
          WHERE revision.tenant_id = $1
            AND revision.incident_id = $2
            AND revision.id = $3
            AND NOT EXISTS (
              SELECT 1
              FROM report_revisions newer_revision
              WHERE newer_revision.tenant_id = revision.tenant_id
                AND newer_revision.incident_id = revision.incident_id
                AND newer_revision.report_draft_id = revision.report_draft_id
                AND newer_revision.revision_number > revision.revision_number
            )
          FOR UPDATE OF revision
        `,
        [lockedIncident.tenant_id, input.incidentId, input.revisionId],
      );
      const locked = result.rows[0];
      if (locked === undefined) {
        throw new ReviewNotFoundError();
      }
      if (
        locked.status === 'APPROVED' &&
        lockedIncident.incident_status === 'APPROVED'
      ) {
        await client.query('COMMIT');
        return toRevision(locked);
      }
      if (
        locked.status !== 'DRAFT' ||
        lockedIncident.incident_status !== 'NEEDS_REVIEW'
      ) {
        throw new ReviewConflictError('Review revision cannot be approved');
      }
      if (lockedIncident.incident_version !== input.expectedIncidentVersion) {
        throw new ReviewConflictError();
      }
      if (
        parseNonNegativeInteger(
          locked.contradiction_count,
          'contradiction count',
        ) > 0 &&
        !locked.acknowledged_contradictions
      ) {
        throw new ReviewConflictError(
          'Material contradictions are not acknowledged',
        );
      }
      if (
        locked.open_question_count > 0 &&
        !locked.acknowledged_open_questions
      ) {
        throw new ReviewConflictError('Open questions are not acknowledged');
      }

      const updated = await client.query<RevisionRow>(
        `
          UPDATE report_revisions
          SET status = 'APPROVED',
              approved_by_subject = $1,
              approved_at = $2
          WHERE tenant_id = $3
            AND incident_id = $4
            AND id = $5
            AND status = 'DRAFT'
          RETURNING ${REVISION_COLUMNS}
        `,
        [
          input.reviewer.subject,
          input.approvedAt,
          lockedIncident.tenant_id,
          input.incidentId,
          input.revisionId,
        ],
      );
      const approved = requireRevision(updated.rows);
      await client.query(
        `
          INSERT INTO report_approvals (
            id,
            tenant_id,
            incident_id,
            report_revision_id,
            approved_by_subject,
            client_request_id,
            approved_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          input.approvalId,
          lockedIncident.tenant_id,
          input.incidentId,
          input.revisionId,
          input.reviewer.subject,
          input.clientRequestId,
          input.approvedAt,
        ],
      );
      const incidentUpdate = await client.query(
        `
          UPDATE incidents
          SET status = 'APPROVED',
              updated_at = $1,
              version = version + 1
          WHERE tenant_id = $2
            AND id = $3
            AND status = 'NEEDS_REVIEW'
            AND version = $4
        `,
        [
          input.approvedAt,
          lockedIncident.tenant_id,
          input.incidentId,
          input.expectedIncidentVersion,
        ],
      );
      if (incidentUpdate.rowCount !== 1) {
        throw new ReviewConflictError();
      }
      await insertAuditEvent(client, {
        id: input.auditEventId,
        tenantId: lockedIncident.tenant_id,
        incidentId: input.incidentId,
        actorId: input.reviewer.subject,
        action: 'REPORT_REVISION_APPROVED',
        targetType: 'REPORT_REVISION',
        targetId: input.revisionId,
        requestId: input.clientRequestId,
        metadata: { revisionNumber: approved.revision_number },
        occurredAt: input.approvedAt,
      });
      await client.query('COMMIT');
      return toRevision(approved);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private loadStatements(
    header: BundleHeaderRow,
  ): Promise<QueryResult<StatementRow>> {
    return this.pool.query<StatementRow>(
      `
        SELECT
          statement.id,
          section.section_type,
          section.position AS section_position,
          statement.position AS statement_position,
          statement.statement_type,
          statement.statement,
          statement.classification,
          ARRAY_AGG(DISTINCT claim_link.claim_id)
            FILTER (WHERE claim_link.claim_id IS NOT NULL) AS claim_ids,
          ARRAY_AGG(DISTINCT timeline_link.timeline_event_id)
            FILTER (WHERE timeline_link.timeline_event_id IS NOT NULL) AS timeline_event_ids
        FROM incident_report_sections section
        JOIN incident_report_statements statement
          ON statement.tenant_id = section.tenant_id
         AND statement.incident_id = section.incident_id
         AND statement.report_draft_id = section.report_draft_id
         AND statement.report_section_id = section.id
        LEFT JOIN report_statement_claim_links claim_link
          ON claim_link.tenant_id = statement.tenant_id
         AND claim_link.incident_id = statement.incident_id
         AND claim_link.report_statement_id = statement.id
        LEFT JOIN report_statement_timeline_event_links timeline_link
          ON timeline_link.tenant_id = statement.tenant_id
         AND timeline_link.incident_id = statement.incident_id
         AND timeline_link.report_statement_id = statement.id
        WHERE section.tenant_id = $1
          AND section.incident_id = $2
          AND section.report_draft_id = $3
        GROUP BY section.id, statement.id
        ORDER BY section.position, statement.position, statement.id
        LIMIT $4
      `,
      [
        header.tenant_id,
        header.incident_id,
        header.report_draft_id,
        MAX_REPORT_STATEMENTS + 1,
      ],
    );
  }

  private loadClaims(header: BundleHeaderRow): Promise<QueryResult<ClaimRow>> {
    return this.pool.query<ClaimRow>(
      `
        SELECT
          claim.id,
          claim.statement,
          claim.classification,
          claim.review_status,
          ARRAY_AGG(DISTINCT link.source_artifact_id)
            FILTER (WHERE link.relationship = 'SUPPORTS') AS supporting_evidence_ids,
          ARRAY_AGG(DISTINCT link.source_artifact_id)
            FILTER (WHERE link.relationship = 'CONTRADICTS') AS contradicting_evidence_ids
        FROM claims claim
        LEFT JOIN claim_evidence_links link
          ON link.tenant_id = claim.tenant_id
         AND link.incident_id = claim.incident_id
         AND link.claim_id = claim.id
        WHERE claim.tenant_id = $1
          AND claim.incident_id = $2
          AND claim.analysis_run_id = $3
        GROUP BY claim.id
        ORDER BY claim.created_at, claim.id
        LIMIT $4
      `,
      [
        header.tenant_id,
        header.incident_id,
        header.analysis_run_id,
        MAX_CLAIMS + 1,
      ],
    );
  }

  private loadTimeline(
    header: BundleHeaderRow,
  ): Promise<QueryResult<TimelineRow>> {
    return this.pool.query<TimelineRow>(
      `
        SELECT
          event.id,
          event.event_time,
          event.summary,
          event.classification,
          ARRAY_AGG(DISTINCT link.source_artifact_id)
            FILTER (WHERE link.source_artifact_id IS NOT NULL) AS evidence_ids
        FROM timeline_events event
        LEFT JOIN timeline_event_evidence_links link
          ON link.tenant_id = event.tenant_id
         AND link.incident_id = event.incident_id
         AND link.timeline_event_id = event.id
        WHERE event.tenant_id = $1
          AND event.incident_id = $2
          AND event.analysis_run_id = $3
        GROUP BY event.id
        ORDER BY event.event_time, event.id
        LIMIT $4
      `,
      [
        header.tenant_id,
        header.incident_id,
        header.analysis_run_id,
        MAX_TIMELINE_EVENTS + 1,
      ],
    );
  }

  private loadEvidence(
    header: BundleHeaderRow,
  ): Promise<QueryResult<EvidenceRow>> {
    return this.pool.query<EvidenceRow>(
      `
        WITH referenced_artifacts AS (
          SELECT link.source_artifact_id
          FROM claim_evidence_links link
          JOIN claims claim
            ON claim.tenant_id = link.tenant_id
           AND claim.incident_id = link.incident_id
           AND claim.id = link.claim_id
          WHERE claim.tenant_id = $1
            AND claim.incident_id = $2
            AND claim.analysis_run_id = $3
          UNION
          SELECT link.source_artifact_id
          FROM timeline_event_evidence_links link
          JOIN timeline_events event
            ON event.tenant_id = link.tenant_id
           AND event.incident_id = link.incident_id
           AND event.id = link.timeline_event_id
          WHERE event.tenant_id = $1
            AND event.incident_id = $2
            AND event.analysis_run_id = $3
        )
        SELECT
          artifact.id,
          artifact.source_type,
          artifact.occurred_at,
          artifact.author_external_id,
          LEFT(artifact.content, 8000) AS content,
          char_length(artifact.content) > 8000 AS content_truncated,
          artifact.source_uri
        FROM source_artifacts artifact
        JOIN referenced_artifacts referenced
          ON referenced.source_artifact_id = artifact.id
        WHERE artifact.tenant_id = $1
          AND artifact.incident_id = $2
          AND artifact.deleted_at IS NULL
          AND artifact.content IS NOT NULL
        ORDER BY artifact.occurred_at, artifact.id
        LIMIT $4
      `,
      [
        header.tenant_id,
        header.incident_id,
        header.analysis_run_id,
        MAX_EVIDENCE + 1,
      ],
    );
  }

  private loadQuestions(
    header: BundleHeaderRow,
  ): Promise<QueryResult<QuestionRow>> {
    return this.pool.query<QuestionRow>(
      `
        SELECT id, question
        FROM analysis_open_questions
        WHERE tenant_id = $1
          AND incident_id = $2
          AND analysis_run_id = $3
        ORDER BY created_at, id
        LIMIT $4
      `,
      [
        header.tenant_id,
        header.incident_id,
        header.analysis_run_id,
        MAX_OPEN_QUESTIONS + 1,
      ],
    );
  }

  private loadRevisions(
    header: BundleHeaderRow,
  ): Promise<QueryResult<RevisionRow>> {
    return this.pool.query<RevisionRow>(
      `
        SELECT ${REVISION_COLUMNS}
        FROM report_revisions
        WHERE tenant_id = $1
          AND incident_id = $2
          AND report_draft_id = $3
        ORDER BY revision_number DESC
        LIMIT 50
      `,
      [header.tenant_id, header.incident_id, header.report_draft_id],
    );
  }
}

async function lockReviewContext(
  client: PoolClient,
  reviewer: ReviewerIdentity,
  incidentId: string,
  reportDraftId: string,
): Promise<LockedReviewRow> {
  const result = await client.query<LockedReviewRow>(
    `
      SELECT
        i.tenant_id,
        i.id AS incident_id,
        i.title,
        i.severity,
        i.status AS incident_status,
        i.version AS incident_version,
        i.created_at AS incident_created_at,
        i.updated_at AS incident_updated_at,
        draft.id AS report_draft_id,
        draft.draft_version,
        draft.rendered_markdown,
        draft.analysis_run_id,
        draft.status AS draft_status
      FROM incidents i
      JOIN incident_report_drafts draft
        ON draft.tenant_id = i.tenant_id
       AND draft.incident_id = i.id
       AND draft.id = $3
      JOIN reviewer_memberships membership
        ON membership.tenant_id = i.tenant_id
       AND membership.cognito_subject = $1
       AND membership.status = 'ACTIVE'
       AND membership.role IN ('REVIEWER', 'ADMIN')
      WHERE i.id = $2
      FOR UPDATE OF i, draft
    `,
    [reviewer.subject, incidentId, reportDraftId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReviewNotFoundError();
  }
  return row;
}

async function findRevisionByRequest(
  client: PoolClient,
  tenantId: string,
  subject: string,
  clientRequestId: string,
): Promise<RevisionRow> {
  const result = await client.query<RevisionRow>(
    `
      SELECT ${REVISION_COLUMNS}
      FROM report_revisions
      WHERE tenant_id = $1
        AND created_by_subject = $2
        AND client_request_id = $3
      LIMIT 1
    `,
    [tenantId, subject, clientRequestId],
  );
  return requireRevision(result.rows);
}

async function insertRevisionStatements(
  client: PoolClient,
  tenantId: string,
  input: CreateReportRevisionInput,
): Promise<void> {
  await client.query(
    `
      INSERT INTO report_revision_statements (
        id,
        tenant_id,
        incident_id,
        report_draft_id,
        report_revision_id,
        original_report_statement_id,
        section_type,
        position,
        decision,
        statement,
        classification,
        created_at
      )
      SELECT
        statement.id,
        $1,
        $2,
        $3,
        $4,
        statement.original_id,
        statement.section_type,
        statement.position,
        statement.decision,
        statement.content,
        statement.classification,
        $12
      FROM UNNEST(
        $5::text[],
        $6::text[],
        $7::text[],
        $8::integer[],
        $9::text[],
        $10::text[],
        $11::text[]
      ) AS statement(
        id,
        original_id,
        section_type,
        position,
        decision,
        content,
        classification
      )
    `,
    [
      tenantId,
      input.incidentId,
      input.reportDraftId,
      input.id,
      input.statements.map((statement) => statement.id),
      input.statements.map((statement) => statement.originalStatementId),
      input.statements.map((statement) => statement.sectionType.toUpperCase()),
      input.statements.map((statement) => statement.position),
      input.statements.map((statement) => statement.decision),
      input.statements.map((statement) => statement.text),
      input.statements.map(
        (statement) => statement.classification?.toUpperCase() ?? null,
      ),
      input.createdAt,
    ],
  );

  const claimLinks = input.statements.flatMap((statement) =>
    statement.claimIds.map((claimId) => ({
      statementId: statement.id,
      claimId,
    })),
  );
  if (claimLinks.length > 0) {
    await client.query(
      `
        INSERT INTO report_revision_claim_links (
          tenant_id,
          incident_id,
          report_revision_statement_id,
          claim_id,
          created_at
        )
        SELECT $1, $2, link.statement_id, link.claim_id, $5
        FROM UNNEST($3::text[], $4::text[])
          AS link(statement_id, claim_id)
      `,
      [
        tenantId,
        input.incidentId,
        claimLinks.map((link) => link.statementId),
        claimLinks.map((link) => link.claimId),
        input.createdAt,
      ],
    );
  }

  const timelineLinks = input.statements.flatMap((statement) =>
    statement.timelineEventIds.map((timelineEventId) => ({
      statementId: statement.id,
      timelineEventId,
    })),
  );
  if (timelineLinks.length > 0) {
    await client.query(
      `
        INSERT INTO report_revision_timeline_event_links (
          tenant_id,
          incident_id,
          report_revision_statement_id,
          timeline_event_id,
          created_at
        )
        SELECT $1, $2, link.statement_id, link.timeline_event_id, $5
        FROM UNNEST($3::text[], $4::text[])
          AS link(statement_id, timeline_event_id)
      `,
      [
        tenantId,
        input.incidentId,
        timelineLinks.map((link) => link.statementId),
        timelineLinks.map((link) => link.timelineEventId),
        input.createdAt,
      ],
    );
  }
}

async function insertAuditEvent(
  client: PoolClient,
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly incidentId: string;
    readonly actorId: string;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly requestId: string;
    readonly metadata: Readonly<Record<string, string | number | boolean>>;
    readonly occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO audit_events (
        id,
        tenant_id,
        incident_id,
        actor_type,
        actor_id,
        action,
        target_type,
        target_id,
        request_id,
        metadata,
        occurred_at
      )
      VALUES ($1, $2, $3, 'USER', $4, $5, $6, $7, $8, $9::jsonb, $10)
    `,
    [
      input.id,
      input.tenantId,
      input.incidentId,
      input.actorId,
      input.action,
      input.targetType,
      input.targetId,
      input.requestId,
      JSON.stringify(input.metadata),
      input.occurredAt,
    ],
  );
}

function toInboxItem(row: InboxRow): ReviewInboxItem {
  return {
    incidentId: row.incident_id,
    title: row.title,
    severity: row.severity,
    status: row.status,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    incidentVersion: row.incident_version,
    reportDraftId: row.report_draft_id,
    claimCount: row.input_claim_count,
    timelineEventCount: row.input_timeline_event_count,
    openQuestionCount: row.input_open_question_count,
    contradictionCount: parseNonNegativeInteger(
      row.contradiction_count,
      'contradiction count',
    ),
    latestRevisionId: row.latest_revision_id,
    latestRevisionNumber: row.latest_revision_number,
    latestRevisionStatus: row.latest_revision_status,
  };
}

function toSections(
  rows: readonly StatementRow[],
): readonly ReviewReportSection[] {
  const sections = new Map<string, ReviewReportSection>();
  for (const row of rows) {
    const sectionType = parseSectionType(row.section_type);
    const statement: ReviewReportStatement = {
      id: row.id,
      sectionType,
      position: row.statement_position,
      statementType: row.statement_type === 'CLAIM' ? 'claim' : 'timeline',
      text: row.statement,
      classification: parseReviewClassification(row.classification),
      claimIds: row.claim_ids ?? [],
      timelineEventIds: row.timeline_event_ids ?? [],
    };
    const existing = sections.get(sectionType);
    if (existing === undefined) {
      sections.set(sectionType, {
        sectionType,
        position: row.section_position,
        statements: [statement],
      });
    } else {
      sections.set(sectionType, {
        ...existing,
        statements: [...existing.statements, statement],
      });
    }
  }
  return [...sections.values()].sort(
    (left, right) => left.position - right.position,
  );
}

function toClaim(row: ClaimRow): ReviewClaim {
  return {
    id: row.id,
    statement: row.statement,
    classification: parseReviewClassification(row.classification),
    reviewStatus: row.review_status,
    supportingEvidenceIds: row.supporting_evidence_ids ?? [],
    contradictingEvidenceIds: row.contradicting_evidence_ids ?? [],
  };
}

function toTimelineEvent(row: TimelineRow): ReviewTimelineEvent {
  return {
    id: row.id,
    occurredAt: toIsoString(row.event_time),
    summary: row.summary,
    classification: parseReviewClassification(row.classification),
    evidenceIds: row.evidence_ids ?? [],
  };
}

function toEvidence(row: EvidenceRow): ReviewEvidence {
  return {
    id: row.id,
    sourceType: row.source_type,
    occurredAt: toIsoString(row.occurred_at),
    authorReference: row.author_external_id,
    content: row.content,
    contentTruncated: row.content_truncated,
    sourceUri: row.source_uri,
  };
}

function toRevisionSummary(row: RevisionRow): ReportRevisionSummary {
  return {
    id: row.id,
    revisionNumber: row.revision_number,
    status: row.status,
    createdAt: toIsoString(row.created_at),
    statementCount: row.statement_count,
    acknowledgedContradictions: row.acknowledged_contradictions,
    acknowledgedOpenQuestions: row.acknowledged_open_questions,
  };
}

function toRevision(row: RevisionRow): ReportRevision {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    incidentId: row.incident_id,
    reportDraftId: row.report_draft_id,
    revisionNumber: row.revision_number,
    status: row.status,
    createdBySubject: row.created_by_subject,
    acknowledgedContradictions: row.acknowledged_contradictions,
    acknowledgedOpenQuestions: row.acknowledged_open_questions,
    statementCount: row.statement_count,
    renderedMarkdown: row.rendered_markdown,
    contentSha256: row.content_sha256,
    createdAt: toDate(row.created_at),
    approvedBySubject: row.approved_by_subject,
    approvedAt: row.approved_at === null ? null : toDate(row.approved_at),
  };
}

function requireRevision(rows: readonly RevisionRow[]): RevisionRow {
  const row = rows[0];
  if (row === undefined) {
    throw new ReviewConflictError();
  }
  return row;
}

function requireBound(
  rows: readonly unknown[],
  maximum: number,
  label: string,
): void {
  if (rows.length > maximum) {
    throw new ReviewConfigurationError(
      `Incident review ${label} exceed the configured response limit`,
    );
  }
}

function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ReviewConfigurationError(
      `PostgreSQL returned an invalid ${label}`,
    );
  }
  return parsed;
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ReviewConfigurationError(
      `PostgreSQL returned an invalid ${label}`,
    );
  }
  return parsed;
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ReviewConfigurationError(
      'PostgreSQL returned an invalid timestamp',
    );
  }
  return date;
}

function toIsoString(value: Date | string): string {
  return toDate(value).toISOString();
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original failure; pg discards failed connections.
  }
}
