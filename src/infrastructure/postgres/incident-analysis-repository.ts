import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  IncidentAnalysisConcurrencyError,
  IncidentAnalysisConfigurationError,
  type AcquireIncidentAnalysisRunInput,
  type AcquireIncidentAnalysisRunResult,
  type CompleteIncidentAnalysisInput,
  type FailIncidentAnalysisInput,
  type IncidentAnalysisEvidenceBundle,
  type IncidentAnalysisRepository,
  type IncidentAnalysisRun,
  type ScheduleIncidentAnalysisRetryInput,
} from '../../application/ports/incident-analysis-repository.js';

interface IncidentEvidenceConfigurationRow {
  readonly title: string;
  readonly collection_status: string | null;
}

interface EvidenceRow {
  readonly id: string;
  readonly source_type: string;
  readonly occurred_at: Date | string;
  readonly author_external_id: string | null;
  readonly content: string;
}

interface AnalysisRunRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly incident_id: string;
  readonly analysis_version: number;
  readonly manifest_sha256: string;
  readonly status: IncidentAnalysisRun['status'];
  readonly provider: string;
  readonly model_name: string;
  readonly prompt_version: string;
  readonly schema_version: string;
  readonly client_request_id: string;
  readonly input_artifact_count: number;
  readonly input_characters: number;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly available_at: Date | string;
  readonly lease_token: string | null;
  readonly lease_expires_at: Date | string | null;
  readonly failure_code: string | null;
  readonly timeline_event_count: number;
  readonly claim_count: number;
  readonly open_question_count: number;
  readonly version: number;
}

const RUN_COLUMNS = `
  id,
  tenant_id,
  incident_id,
  analysis_version,
  manifest_sha256,
  status,
  provider,
  model_name,
  prompt_version,
  schema_version,
  client_request_id,
  input_artifact_count,
  input_characters,
  attempt_count,
  max_attempts,
  available_at,
  lease_token,
  lease_expires_at,
  failure_code,
  timeline_event_count,
  claim_count,
  open_question_count,
  version
`;

/** Durable analysis lease and atomic evidence-linked output persistence. */
export class PostgresIncidentAnalysisRepository implements IncidentAnalysisRepository {
  public constructor(private readonly pool: Pool) {}

  public async loadEvidence(
    tenantId: string,
    incidentId: string,
    artifactLimit: number,
  ): Promise<IncidentAnalysisEvidenceBundle> {
    const incident = await this.pool.query<IncidentEvidenceConfigurationRow>(
      `
        SELECT i.title, c.status AS collection_status
        FROM incidents i
        LEFT JOIN slack_thread_collections c
          ON c.tenant_id = i.tenant_id
         AND c.incident_id = i.id
        WHERE i.tenant_id = $1
          AND i.id = $2
        LIMIT 1
      `,
      [tenantId, incidentId],
    );
    const configuration = incident.rows[0];
    if (configuration === undefined) {
      throw new IncidentAnalysisConfigurationError('Incident was not found');
    }
    if (configuration.collection_status !== 'COMPLETE') {
      throw new IncidentAnalysisConfigurationError(
        'Slack evidence collection must complete before analysis',
      );
    }

    const evidence = await this.pool.query<EvidenceRow>(
      `
        SELECT
          id,
          source_type,
          occurred_at,
          author_external_id,
          content
        FROM source_artifacts
        WHERE tenant_id = $1
          AND incident_id = $2
          AND deleted_at IS NULL
          AND content IS NOT NULL
        ORDER BY occurred_at, id
        LIMIT $3
      `,
      [tenantId, incidentId, artifactLimit],
    );
    return {
      incidentTitle: configuration.title,
      artifacts: evidence.rows.map((row) => ({
        id: row.id,
        sourceType: row.source_type,
        occurredAt: toDate(row.occurred_at),
        authorExternalId: row.author_external_id,
        content: row.content,
      })),
    };
  }

  public async acquire(
    input: AcquireIncidentAnalysisRunInput,
  ): Promise<AcquireIncidentAnalysisRunResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<AnalysisRunRow>(
        `
          INSERT INTO incident_analysis_runs (
            id,
            tenant_id,
            incident_id,
            analysis_version,
            manifest_sha256,
            status,
            provider,
            model_name,
            prompt_version,
            schema_version,
            client_request_id,
            input_artifact_count,
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
            $1, $2, $3, $4, $5, 'RUNNING', $6, $7, $8, $9, $10,
            $11, $12, 1, $13, $14, $15, $16, $14, $14
          )
          ON CONFLICT (tenant_id, incident_id, analysis_version) DO NOTHING
          RETURNING ${RUN_COLUMNS}
        `,
        [
          input.id,
          input.tenantId,
          input.incidentId,
          input.analysisVersion,
          input.manifestSha256,
          input.provider,
          input.model,
          input.promptVersion,
          input.schemaVersion,
          input.clientRequestId,
          input.inputArtifactCount,
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
        return { outcome: 'ACQUIRED', run: toRun(created) };
      }

      const existing = await client.query<AnalysisRunRow>(
        `
          SELECT ${RUN_COLUMNS}
          FROM incident_analysis_runs
          WHERE tenant_id = $1
            AND incident_id = $2
            AND analysis_version = $3
          FOR UPDATE
        `,
        [input.tenantId, input.incidentId, input.analysisVersion],
      );
      const row = requireRunRow(existing.rows);
      assertCompatibleRun(row, input);
      const run = toRun(row);
      if (run.status === 'COMPLETE' || run.status === 'FAILED') {
        await client.query('COMMIT');
        return { outcome: run.status, run };
      }

      const readyAt =
        run.status === 'RUNNING' ? run.leaseExpiresAt : run.availableAt;
      if (readyAt !== null && readyAt.getTime() > input.now.getTime()) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((readyAt.getTime() - input.now.getTime()) / 1_000),
        );
        await client.query('COMMIT');
        return { outcome: 'WAIT', retryAfterSeconds };
      }
      if (run.attemptCount >= run.maxAttempts) {
        const failed = await client.query<AnalysisRunRow>(
          `
            UPDATE incident_analysis_runs
            SET status = 'FAILED',
                lease_token = NULL,
                lease_expires_at = NULL,
                failure_code = 'ANALYSIS_ATTEMPT_LIMIT_EXCEEDED',
                updated_at = $1,
                finished_at = $1,
                version = version + 1
            WHERE tenant_id = $2
              AND incident_id = $3
              AND id = $4
              AND version = $5
            RETURNING ${RUN_COLUMNS}
          `,
          [input.now, run.tenantId, run.incidentId, run.id, run.version],
        );
        const persisted = toRun(requireRunRow(failed.rows));
        await client.query('COMMIT');
        return { outcome: 'FAILED', run: persisted };
      }

      const reacquired = await client.query<AnalysisRunRow>(
        `
          UPDATE incident_analysis_runs
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
          RETURNING ${RUN_COLUMNS}
        `,
        [
          input.now,
          input.leaseToken,
          input.leaseExpiresAt,
          input.clientRequestId,
          run.tenantId,
          run.incidentId,
          run.id,
          run.version,
        ],
      );
      const persisted = toRun(requireRunRow(reacquired.rows));
      await client.query('COMMIT');
      return { outcome: 'ACQUIRED', run: persisted };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async scheduleRetry(
    input: ScheduleIncidentAnalysisRetryInput,
  ): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE incident_analysis_runs
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
        input.run.tenantId,
        input.run.incidentId,
        input.run.id,
        input.run.version,
        input.leaseToken,
      ],
    );
    if (result.rowCount !== 1) {
      throw new IncidentAnalysisConcurrencyError();
    }
  }

  public async complete(
    input: CompleteIncidentAnalysisInput,
  ): Promise<IncidentAnalysisRun> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const event of input.analysis.timeline) {
        const eventId = generatedId('timeline', input.run.id, event.key);
        await client.query(
          `
            INSERT INTO timeline_events (
              id,
              tenant_id,
              incident_id,
              event_type,
              classification,
              event_time,
              summary,
              source_artifact_id,
              metadata,
              created_at,
              updated_at,
              analysis_run_id
            )
            VALUES (
              $1, $2, $3, 'MODEL_EXTRACTED', $4, $5, $6, $7,
              $8::jsonb, $9, $9, $10
            )
          `,
          [
            eventId,
            input.run.tenantId,
            input.run.incidentId,
            event.classification.toUpperCase(),
            event.occurredAt,
            event.summary,
            event.evidenceIds[0],
            JSON.stringify({
              modelKey: event.key,
              analysisRunId: input.run.id,
            }),
            input.completedAt,
            input.run.id,
          ],
        );
        for (const evidenceId of event.evidenceIds) {
          await client.query(
            `
              INSERT INTO timeline_event_evidence_links (
                tenant_id,
                incident_id,
                timeline_event_id,
                source_artifact_id,
                created_at
              )
              VALUES ($1, $2, $3, $4, $5)
            `,
            [
              input.run.tenantId,
              input.run.incidentId,
              eventId,
              evidenceId,
              input.completedAt,
            ],
          );
        }
      }

      for (const claim of input.analysis.claims) {
        const claimId = generatedId('claim', input.run.id, claim.key);
        await client.query(
          `
            INSERT INTO claims (
              id,
              tenant_id,
              incident_id,
              statement,
              classification,
              review_status,
              model_provider,
              model_name,
              prompt_version,
              created_at,
              updated_at,
              analysis_run_id
            )
            VALUES (
              $1, $2, $3, $4, $5, 'UNREVIEWED', $6, $7, $8, $9, $9, $10
            )
          `,
          [
            claimId,
            input.run.tenantId,
            input.run.incidentId,
            claim.statement,
            claim.classification.toUpperCase(),
            input.run.provider,
            input.providerModel,
            input.run.promptVersion,
            input.completedAt,
            input.run.id,
          ],
        );
        await insertClaimEvidenceLinks(
          client,
          input,
          claimId,
          claim.supportingEvidenceIds,
          'SUPPORTS',
        );
        await insertClaimEvidenceLinks(
          client,
          input,
          claimId,
          claim.contradictingEvidenceIds,
          'CONTRADICTS',
        );
      }

      for (const [index, question] of input.analysis.openQuestions.entries()) {
        await client.query(
          `
            INSERT INTO analysis_open_questions (
              id,
              tenant_id,
              incident_id,
              analysis_run_id,
              question,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            generatedId('question', input.run.id, `${index}:${question}`),
            input.run.tenantId,
            input.run.incidentId,
            input.run.id,
            question,
            input.completedAt,
          ],
        );
      }

      const updated = await client.query<AnalysisRunRow>(
        `
          UPDATE incident_analysis_runs
          SET status = 'COMPLETE',
              provider_response_id = $1,
              provider_model_name = $2,
              input_tokens = $3,
              output_tokens = $4,
              total_tokens = $5,
              lease_token = NULL,
              lease_expires_at = NULL,
              failure_code = NULL,
              timeline_event_count = $6,
              claim_count = $7,
              open_question_count = $8,
              updated_at = $9,
              finished_at = $9,
              version = version + 1
          WHERE tenant_id = $10
            AND incident_id = $11
            AND id = $12
            AND status = 'RUNNING'
            AND version = $13
            AND lease_token = $14
          RETURNING ${RUN_COLUMNS}
        `,
        [
          input.providerResponseId,
          input.providerModel,
          input.inputTokens,
          input.outputTokens,
          input.totalTokens,
          input.analysis.timeline.length,
          input.analysis.claims.length,
          input.analysis.openQuestions.length,
          input.completedAt,
          input.run.tenantId,
          input.run.incidentId,
          input.run.id,
          input.run.version,
          input.leaseToken,
        ],
      );
      const persisted = toRun(requireRunRow(updated.rows));
      await client.query('COMMIT');
      return persisted;
    } catch (error) {
      await rollbackQuietly(client);
      if (error instanceof IncidentAnalysisConfigurationError) {
        throw new IncidentAnalysisConcurrencyError();
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async fail(
    input: FailIncidentAnalysisInput,
  ): Promise<IncidentAnalysisRun> {
    const result = await this.pool.query<AnalysisRunRow>(
      `
        UPDATE incident_analysis_runs
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
        RETURNING ${RUN_COLUMNS}
      `,
      [
        input.failureCode,
        input.failedAt,
        input.run.tenantId,
        input.run.incidentId,
        input.run.id,
        input.run.version,
        input.leaseToken,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new IncidentAnalysisConcurrencyError();
    }
    return toRun(row);
  }
}

async function insertClaimEvidenceLinks(
  client: PoolClient,
  input: CompleteIncidentAnalysisInput,
  claimId: string,
  evidenceIds: readonly string[],
  relationship: 'SUPPORTS' | 'CONTRADICTS',
): Promise<void> {
  for (const evidenceId of evidenceIds) {
    await client.query(
      `
        INSERT INTO claim_evidence_links (
          tenant_id,
          incident_id,
          claim_id,
          source_artifact_id,
          relationship,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        input.run.tenantId,
        input.run.incidentId,
        claimId,
        evidenceId,
        relationship,
        input.completedAt,
      ],
    );
  }
}

function assertCompatibleRun(
  row: AnalysisRunRow,
  input: AcquireIncidentAnalysisRunInput,
): void {
  if (
    row.manifest_sha256 !== input.manifestSha256 ||
    row.provider !== input.provider ||
    row.model_name !== input.model ||
    row.prompt_version !== input.promptVersion ||
    row.schema_version !== input.schemaVersion ||
    row.input_artifact_count !== input.inputArtifactCount ||
    row.input_characters !== input.inputCharacters ||
    row.max_attempts !== input.maxAttempts
  ) {
    throw new IncidentAnalysisConfigurationError(
      'Existing analysis version does not match the current immutable configuration or evidence manifest',
    );
  }
}

function toRun(row: AnalysisRunRow): IncidentAnalysisRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    incidentId: row.incident_id,
    analysisVersion: row.analysis_version,
    manifestSha256: row.manifest_sha256,
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
    timelineEventCount: row.timeline_event_count,
    claimCount: row.claim_count,
    openQuestionCount: row.open_question_count,
    version: row.version,
  };
}

function requireRunRow(rows: readonly AnalysisRunRow[]): AnalysisRunRow {
  const row = rows[0];
  if (row === undefined) {
    throw new IncidentAnalysisConfigurationError(
      'Incident analysis run was not found after a state change',
    );
  }
  return row;
}

function generatedId(kind: string, runId: string, key: string): string {
  return `analysis-${kind}-${createHash('sha256')
    .update(runId, 'utf8')
    .update('\0', 'utf8')
    .update(key, 'utf8')
    .digest('hex')}`;
}

function toDate(value: Date | string): Date {
  if (value instanceof Date) {
    return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new IncidentAnalysisConfigurationError(
      'PostgreSQL returned an invalid timestamp',
    );
  }
  return date;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original database error; PostgreSQL rolls the transaction
    // back when the failed connection is discarded.
  }
}
