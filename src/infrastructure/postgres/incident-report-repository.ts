import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  IncidentReportConcurrencyError,
  IncidentReportConfigurationError,
  type AcquireIncidentReportDraftInput,
  type AcquireIncidentReportDraftResult,
  type CompleteIncidentReportDraftInput,
  type FailIncidentReportDraftInput,
  type IncidentReportDraft,
  type IncidentReportRepository,
  type ScheduleIncidentReportRetryInput,
} from '../../application/ports/incident-report-repository.js';
import type {
  IncidentReviewReadyDraft,
  IncidentReviewReadyDraftReader,
} from '../../application/ports/incident-review-ready-notifier.js';
import {
  INCIDENT_REPORT_SECTION_TYPES,
  type IncidentReportManifest,
  type ModelEvidenceClassification,
} from '../../application/report/incident-report.js';

interface ReportConfigurationRow {
  readonly title: string;
  readonly analysis_status: string;
}

interface ReportClaimRow {
  readonly id: string;
  readonly statement: string;
  readonly classification: string;
  readonly supporting_evidence_count: number | string;
  readonly contradicting_evidence_count: number | string;
}

interface ReportTimelineRow {
  readonly id: string;
  readonly event_time: Date | string;
  readonly summary: string;
  readonly classification: string;
  readonly evidence_count: number | string;
}

interface OpenQuestionRow {
  readonly id: string;
  readonly question: string;
}

interface CoverageRow {
  readonly source_id: string;
  readonly display_name: string | null;
  readonly provider_source_id: string;
  readonly source_state: string;
  readonly collected_message_count: number;
  readonly completion_or_failure_reason: string | null;
}

interface ReportDraftRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly incident_id: string;
  readonly analysis_run_id: string;
  readonly draft_version: number;
  readonly input_manifest_sha256: string;
  readonly status: IncidentReportDraft['status'];
  readonly provider: string;
  readonly model_name: string;
  readonly prompt_version: string;
  readonly schema_version: string;
  readonly client_request_id: string;
  readonly input_claim_count: number;
  readonly input_timeline_event_count: number;
  readonly input_open_question_count: number;
  readonly input_characters: number;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly available_at: Date | string;
  readonly lease_token: string | null;
  readonly lease_expires_at: Date | string | null;
  readonly failure_code: string | null;
  readonly section_count: number;
  readonly statement_count: number;
  readonly version: number;
}

interface ReviewReadyDraftRow {
  readonly id: string;
  readonly input_timeline_event_count: number | string;
  readonly input_claim_count: number | string;
  readonly input_open_question_count: number | string;
}

const DRAFT_COLUMNS = `
  id,
  tenant_id,
  incident_id,
  analysis_run_id,
  draft_version,
  input_manifest_sha256,
  status,
  provider,
  model_name,
  prompt_version,
  schema_version,
  client_request_id,
  input_claim_count,
  input_timeline_event_count,
  input_open_question_count,
  input_characters,
  attempt_count,
  max_attempts,
  available_at,
  lease_token,
  lease_expires_at,
  failure_code,
  section_count,
  statement_count,
  version
`;

/** Durable report lease and atomic source-linked draft persistence. */
export class PostgresIncidentReportRepository
  implements IncidentReportRepository, IncidentReviewReadyDraftReader
{
  public constructor(private readonly pool: Pool) {}

  public async loadManifest(
    tenantId: string,
    incidentId: string,
    analysisRunId: string,
    sourceLimit: number,
  ): Promise<IncidentReportManifest> {
    const configuration = await this.pool.query<ReportConfigurationRow>(
      `
        SELECT i.title, a.status AS analysis_status
        FROM incidents i
        JOIN incident_analysis_runs a
          ON a.tenant_id = i.tenant_id
         AND a.incident_id = i.id
         AND a.id = $3
        WHERE i.tenant_id = $1
          AND i.id = $2
        LIMIT 1
      `,
      [tenantId, incidentId, analysisRunId],
    );
    const configured = configuration.rows[0];
    if (configured === undefined) {
      throw new IncidentReportConfigurationError(
        'Incident analysis was not found',
      );
    }
    if (configured.analysis_status !== 'COMPLETE') {
      throw new IncidentReportConfigurationError(
        'Incident analysis must complete before report generation',
      );
    }

    const [claims, timeline, openQuestions, coverage] = await Promise.all([
      this.pool.query<ReportClaimRow>(
        `
          SELECT
            c.id,
            c.statement,
            c.classification,
            COUNT(*) FILTER (WHERE l.relationship = 'SUPPORTS') AS supporting_evidence_count,
            COUNT(*) FILTER (WHERE l.relationship = 'CONTRADICTS') AS contradicting_evidence_count
          FROM claims c
          LEFT JOIN claim_evidence_links l
            ON l.tenant_id = c.tenant_id
           AND l.incident_id = c.incident_id
           AND l.claim_id = c.id
          WHERE c.tenant_id = $1
            AND c.incident_id = $2
            AND c.analysis_run_id = $3
            AND c.review_status <> 'REJECTED'
          GROUP BY c.id
          ORDER BY c.created_at, c.id
          LIMIT $4
        `,
        [tenantId, incidentId, analysisRunId, sourceLimit],
      ),
      this.pool.query<ReportTimelineRow>(
        `
          SELECT
            e.id,
            e.event_time,
            e.summary,
            e.classification,
            COUNT(l.source_artifact_id) AS evidence_count
          FROM timeline_events e
          LEFT JOIN timeline_event_evidence_links l
            ON l.tenant_id = e.tenant_id
           AND l.incident_id = e.incident_id
           AND l.timeline_event_id = e.id
          WHERE e.tenant_id = $1
            AND e.incident_id = $2
            AND e.analysis_run_id = $3
          GROUP BY e.id
          ORDER BY e.event_time, e.id
          LIMIT $4
        `,
        [tenantId, incidentId, analysisRunId, sourceLimit],
      ),
      this.pool.query<OpenQuestionRow>(
        `
          SELECT id, question
          FROM analysis_open_questions
          WHERE tenant_id = $1
            AND incident_id = $2
            AND analysis_run_id = $3
          ORDER BY created_at, id
          LIMIT $4
        `,
        [tenantId, incidentId, analysisRunId, sourceLimit],
      ),
      this.pool.query<CoverageRow>(
        `
          SELECT
            source.id AS source_id,
            source.display_name,
            source.provider_source_id,
            manifest.source_state,
            manifest.collected_message_count,
            manifest.completion_or_failure_reason
          FROM incident_sources source
          JOIN source_coverage_manifests manifest
            ON manifest.tenant_id = source.tenant_id
           AND manifest.incident_id = source.incident_id
           AND manifest.source_id = source.id
           AND manifest.manifest_version = 1
          WHERE source.tenant_id = $1 AND source.incident_id = $2
          ORDER BY source.source_role = 'PRIMARY' DESC, source.id
          LIMIT 5
        `,
        [tenantId, incidentId],
      ),
    ]);

    return {
      incidentTitle: configured.title,
      analysisRunId,
      claims: claims.rows.map((row) => ({
        id: row.id,
        statement: row.statement,
        classification: parseClassification(row.classification),
        supportingEvidenceCount: parseCount(row.supporting_evidence_count),
        contradictingEvidenceCount: parseCount(
          row.contradicting_evidence_count,
        ),
      })),
      timeline: timeline.rows.map((row) => ({
        id: row.id,
        occurredAt: toDate(row.event_time).toISOString(),
        summary: row.summary,
        classification: parseClassification(row.classification),
        evidenceCount: parseCount(row.evidence_count),
      })),
      openQuestions: openQuestions.rows.map((row) => ({
        id: row.id,
        question: row.question,
      })),
      coverage: coverage.rows.map((row) => ({
        sourceId: row.source_id,
        sourceName:
          row.display_name === null
            ? `#${row.provider_source_id}`
            : `#${row.display_name}`,
        state: row.source_state,
        messageCount: row.collected_message_count,
        reason: row.completion_or_failure_reason,
      })),
    };
  }

  public async findReadyDraft(
    tenantId: string,
    incidentId: string,
    reportDraftId: string,
  ): Promise<IncidentReviewReadyDraft | null> {
    const result = await this.pool.query<ReviewReadyDraftRow>(
      `
        SELECT
          id,
          input_timeline_event_count,
          input_claim_count,
          input_open_question_count
        FROM incident_report_drafts
        WHERE tenant_id = $1
          AND incident_id = $2
          AND id = $3
          AND status = 'NEEDS_REVIEW'
        LIMIT 1
      `,
      [tenantId, incidentId, reportDraftId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          timelineEventCount: parseCount(row.input_timeline_event_count),
          claimCount: parseCount(row.input_claim_count),
          openQuestionCount: parseCount(row.input_open_question_count),
        };
  }

  public async acquire(
    input: AcquireIncidentReportDraftInput,
  ): Promise<AcquireIncidentReportDraftResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<ReportDraftRow>(
        `
          INSERT INTO incident_report_drafts (
            id,
            tenant_id,
            incident_id,
            analysis_run_id,
            draft_version,
            input_manifest_sha256,
            status,
            provider,
            model_name,
            prompt_version,
            schema_version,
            client_request_id,
            input_claim_count,
            input_timeline_event_count,
            input_open_question_count,
            input_characters,
            attempt_count,
            max_attempts,
            available_at,
            lease_token,
            lease_expires_at,
            started_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, 'RUNNING', $7, $8, $9, $10, $11,
            $12, $13, $14, $15, 1, $16, $17, $18, $19, $17, $17
          )
          ON CONFLICT (
            tenant_id,
            incident_id,
            analysis_run_id,
            draft_version
          ) DO NOTHING
          RETURNING ${DRAFT_COLUMNS}
        `,
        [
          input.id,
          input.tenantId,
          input.incidentId,
          input.analysisRunId,
          input.draftVersion,
          input.inputManifestSha256,
          input.provider,
          input.model,
          input.promptVersion,
          input.schemaVersion,
          input.clientRequestId,
          input.inputClaimCount,
          input.inputTimelineEventCount,
          input.inputOpenQuestionCount,
          input.inputCharacters,
          input.maxAttempts,
          input.now,
          input.leaseToken,
          input.leaseExpiresAt,
        ],
      );
      const created = inserted.rows[0];
      if (created !== undefined) {
        await client.query('COMMIT');
        return { outcome: 'ACQUIRED', draft: toDraft(created) };
      }

      const existing = await client.query<ReportDraftRow>(
        `
          SELECT ${DRAFT_COLUMNS}
          FROM incident_report_drafts
          WHERE tenant_id = $1
            AND incident_id = $2
            AND analysis_run_id = $3
            AND draft_version = $4
          FOR UPDATE
        `,
        [
          input.tenantId,
          input.incidentId,
          input.analysisRunId,
          input.draftVersion,
        ],
      );
      const row = requireDraftRow(existing.rows);
      assertCompatibleDraft(row, input);
      const draft = toDraft(row);
      if (draft.status === 'NEEDS_REVIEW' || draft.status === 'FAILED') {
        await client.query('COMMIT');
        return { outcome: draft.status, draft };
      }

      const readyAt =
        draft.status === 'RUNNING' ? draft.leaseExpiresAt : draft.availableAt;
      if (readyAt !== null && readyAt.getTime() > input.now.getTime()) {
        await client.query('COMMIT');
        return {
          outcome: 'WAIT',
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((readyAt.getTime() - input.now.getTime()) / 1_000),
          ),
        };
      }
      if (draft.attemptCount >= draft.maxAttempts) {
        const failed = await client.query<ReportDraftRow>(
          `
            UPDATE incident_report_drafts
            SET status = 'FAILED',
                lease_token = NULL,
                lease_expires_at = NULL,
                failure_code = 'REPORT_ATTEMPT_LIMIT_EXCEEDED',
                updated_at = $1,
                finished_at = $1,
                version = version + 1
            WHERE tenant_id = $2
              AND incident_id = $3
              AND id = $4
              AND version = $5
            RETURNING ${DRAFT_COLUMNS}
          `,
          [
            input.now,
            draft.tenantId,
            draft.incidentId,
            draft.id,
            draft.version,
          ],
        );
        const persisted = toDraft(requireDraftRow(failed.rows));
        await client.query('COMMIT');
        return { outcome: 'FAILED', draft: persisted };
      }

      const reacquired = await client.query<ReportDraftRow>(
        `
          UPDATE incident_report_drafts
          SET status = 'RUNNING',
              attempt_count = attempt_count + 1,
              available_at = $1,
              lease_token = $2,
              lease_expires_at = $3,
              client_request_id = $4,
              failure_code = NULL,
              updated_at = $1,
              version = version + 1
          WHERE tenant_id = $5
            AND incident_id = $6
            AND id = $7
            AND version = $8
          RETURNING ${DRAFT_COLUMNS}
        `,
        [
          input.now,
          input.leaseToken,
          input.leaseExpiresAt,
          input.clientRequestId,
          draft.tenantId,
          draft.incidentId,
          draft.id,
          draft.version,
        ],
      );
      const persisted = toDraft(requireDraftRow(reacquired.rows));
      await client.query('COMMIT');
      return { outcome: 'ACQUIRED', draft: persisted };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async scheduleRetry(
    input: ScheduleIncidentReportRetryInput,
  ): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE incident_report_drafts
        SET status = 'RETRY_WAIT',
            available_at = $1,
            lease_token = NULL,
            lease_expires_at = NULL,
            failure_code = $2,
            updated_at = $3,
            version = version + 1
        WHERE tenant_id = $4
          AND incident_id = $5
          AND id = $6
          AND status = 'RUNNING'
          AND version = $7
          AND lease_token = $8
      `,
      [
        input.availableAt,
        input.failureCode,
        input.now,
        input.draft.tenantId,
        input.draft.incidentId,
        input.draft.id,
        input.draft.version,
        input.leaseToken,
      ],
    );
    if (result.rowCount !== 1) {
      throw new IncidentReportConcurrencyError();
    }
  }

  public async complete(
    input: CompleteIncidentReportDraftInput,
  ): Promise<IncidentReportDraft> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let statementCount = 0;
      for (const sectionType of INCIDENT_REPORT_SECTION_TYPES) {
        const section = input.report.sections.find(
          (candidate) => candidate.sectionType === sectionType,
        );
        if (section === undefined) {
          throw new IncidentReportConfigurationError(
            `Validated report is missing section ${sectionType}`,
          );
        }
        const sectionId = generatedId(
          'report-section',
          input.draft.id,
          sectionType,
        );
        const sectionPosition =
          INCIDENT_REPORT_SECTION_TYPES.indexOf(sectionType);
        await client.query(
          `
            INSERT INTO incident_report_sections (
              id,
              tenant_id,
              incident_id,
              report_draft_id,
              section_type,
              position,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            sectionId,
            input.draft.tenantId,
            input.draft.incidentId,
            input.draft.id,
            sectionType.toUpperCase(),
            sectionPosition,
            input.completedAt,
          ],
        );
        for (const [position, statement] of section.statements.entries()) {
          const statementId = generatedId(
            'report-statement',
            input.draft.id,
            statement.key,
          );
          await client.query(
            `
              INSERT INTO incident_report_statements (
                id,
                tenant_id,
                incident_id,
                report_draft_id,
                report_section_id,
                model_key,
                statement_type,
                statement,
                classification,
                position,
                created_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `,
            [
              statementId,
              input.draft.tenantId,
              input.draft.incidentId,
              input.draft.id,
              sectionId,
              statement.key,
              statement.statementType.toUpperCase(),
              statement.text,
              statement.classification.toUpperCase(),
              position,
              input.completedAt,
            ],
          );
          await insertReportSourceLinks(client, input, statementId, statement);
          statementCount += 1;
        }
      }

      const updated = await client.query<ReportDraftRow>(
        `
          UPDATE incident_report_drafts
          SET status = 'NEEDS_REVIEW',
              provider_response_id = $1,
              provider_model_name = $2,
              input_tokens = $3,
              output_tokens = $4,
              total_tokens = $5,
              lease_token = NULL,
              lease_expires_at = NULL,
              failure_code = NULL,
              section_count = $6,
              statement_count = $7,
              rendered_markdown = $8,
              updated_at = $9,
              finished_at = $9,
              version = version + 1
          WHERE tenant_id = $10
            AND incident_id = $11
            AND id = $12
            AND status = 'RUNNING'
            AND version = $13
            AND lease_token = $14
          RETURNING ${DRAFT_COLUMNS}
        `,
        [
          input.providerResponseId,
          input.providerModel,
          input.inputTokens,
          input.outputTokens,
          input.totalTokens,
          INCIDENT_REPORT_SECTION_TYPES.length,
          statementCount,
          input.renderedMarkdown,
          input.completedAt,
          input.draft.tenantId,
          input.draft.incidentId,
          input.draft.id,
          input.draft.version,
          input.leaseToken,
        ],
      );
      const persisted = toDraft(requireDraftRow(updated.rows));
      await client.query('COMMIT');
      return persisted;
    } catch (error) {
      await rollbackQuietly(client);
      if (error instanceof IncidentReportConfigurationError) {
        throw error;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async fail(
    input: FailIncidentReportDraftInput,
  ): Promise<IncidentReportDraft> {
    const result = await this.pool.query<ReportDraftRow>(
      `
        UPDATE incident_report_drafts
        SET status = 'FAILED',
            lease_token = NULL,
            lease_expires_at = NULL,
            failure_code = $1,
            updated_at = $2,
            finished_at = $2,
            version = version + 1
        WHERE tenant_id = $3
          AND incident_id = $4
          AND id = $5
          AND status = 'RUNNING'
          AND version = $6
          AND lease_token = $7
        RETURNING ${DRAFT_COLUMNS}
      `,
      [
        input.failureCode,
        input.failedAt,
        input.draft.tenantId,
        input.draft.incidentId,
        input.draft.id,
        input.draft.version,
        input.leaseToken,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new IncidentReportConcurrencyError();
    }
    return toDraft(row);
  }
}

async function insertReportSourceLinks(
  client: PoolClient,
  input: CompleteIncidentReportDraftInput,
  statementId: string,
  statement: CompleteIncidentReportDraftInput['report']['sections'][number]['statements'][number],
): Promise<void> {
  for (const claimId of statement.claimIds) {
    await client.query(
      `
        INSERT INTO report_statement_claim_links (
          tenant_id,
          incident_id,
          report_statement_id,
          claim_id,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        input.draft.tenantId,
        input.draft.incidentId,
        statementId,
        claimId,
        input.completedAt,
      ],
    );
  }
  for (const eventId of statement.timelineEventIds) {
    await client.query(
      `
        INSERT INTO report_statement_timeline_event_links (
          tenant_id,
          incident_id,
          report_statement_id,
          timeline_event_id,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        input.draft.tenantId,
        input.draft.incidentId,
        statementId,
        eventId,
        input.completedAt,
      ],
    );
  }
}

function assertCompatibleDraft(
  row: ReportDraftRow,
  input: AcquireIncidentReportDraftInput,
): void {
  if (
    row.input_manifest_sha256 !== input.inputManifestSha256 ||
    row.provider !== input.provider ||
    row.model_name !== input.model ||
    row.prompt_version !== input.promptVersion ||
    row.schema_version !== input.schemaVersion ||
    row.input_claim_count !== input.inputClaimCount ||
    row.input_timeline_event_count !== input.inputTimelineEventCount ||
    row.input_open_question_count !== input.inputOpenQuestionCount ||
    row.input_characters !== input.inputCharacters ||
    row.max_attempts !== input.maxAttempts
  ) {
    throw new IncidentReportConfigurationError(
      'Existing report version does not match the immutable configuration or source manifest',
    );
  }
}

function toDraft(row: ReportDraftRow): IncidentReportDraft {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    incidentId: row.incident_id,
    analysisRunId: row.analysis_run_id,
    draftVersion: row.draft_version,
    inputManifestSha256: row.input_manifest_sha256,
    status: row.status,
    provider: row.provider,
    model: row.model_name,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    clientRequestId: row.client_request_id,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    availableAt: toDate(row.available_at),
    leaseToken: row.lease_token,
    leaseExpiresAt:
      row.lease_expires_at === null ? null : toDate(row.lease_expires_at),
    failureCode: row.failure_code,
    sectionCount: row.section_count,
    statementCount: row.statement_count,
    version: row.version,
  };
}

function requireDraftRow(rows: readonly ReportDraftRow[]): ReportDraftRow {
  const row = rows[0];
  if (row === undefined) {
    throw new IncidentReportConcurrencyError();
  }
  return row;
}

function parseClassification(value: string): ModelEvidenceClassification {
  const normalized = value.toLowerCase();
  switch (normalized) {
    case 'directly_observed':
    case 'corroborated':
    case 'participant_assertion':
    case 'hypothesis':
    case 'correlated_inference':
    case 'disputed':
    case 'unknown':
      return normalized;
    case 'human_confirmed':
      // A model-authored analysis can never contain HUMAN_CONFIRMED. If future
      // review feeds approved claims into regeneration, treat it as corroborated
      // rather than giving the writer a privileged classification.
      return 'corroborated';
    default:
      throw new IncidentReportConfigurationError(
        'PostgreSQL returned an unsupported evidence classification',
      );
  }
}

function parseCount(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new IncidentReportConfigurationError(
      'PostgreSQL returned an invalid report source count',
    );
  }
  return parsed;
}

function toDate(value: Date | string): Date {
  if (value instanceof Date) {
    return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new IncidentReportConfigurationError(
      'PostgreSQL returned an invalid report timestamp',
    );
  }
  return date;
}

function generatedId(prefix: string, runId: string, key: string): string {
  return `${prefix}_${createHash('sha256')
    .update(`${runId}\0${key}`, 'utf8')
    .digest('hex')}`;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original error; PostgreSQL will discard the failed session.
  }
}
