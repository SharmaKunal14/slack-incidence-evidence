import type { Pool, PoolClient } from 'pg';
import type {
  AdvanceIncidentSourceCollectionInput,
  FinishIncidentSourceCollectionInput,
  IncidentSourceCollection,
  IncidentSourceCollectionRepository,
} from '../../application/ports/incident-source-collection-repository.js';
import {
  IncidentSourceCollectionConcurrencyError,
  IncidentSourceCollectionConfigurationError,
} from '../../application/ports/incident-source-collection-repository.js';
import type { IncidentSourceStatus } from '../../domain/incident-source.js';

interface CollectionRow {
  readonly tenant_id: string;
  readonly incident_id: string;
  readonly source_id: string;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly channel_id: string;
  readonly source_kind: 'SLACK_CHANNEL' | 'SLACK_THREAD';
  readonly display_name: string | null;
  readonly requested_start_at: Date | string;
  readonly requested_end_at: Date | string;
  readonly anchor_thread_timestamps: string[];
  readonly status: IncidentSourceStatus;
  readonly phase: IncidentSourceCollection['phase'];
  readonly anchor_index: number;
  readonly collection_cursor: string | null;
  readonly pages_collected: number;
  readonly collected_message_count: number;
  readonly rate_limit_count: number;
  readonly transient_failure_count: number;
  readonly checkpoint_version: number;
  readonly retention_days: number;
}

const COLLECTION_QUERY = `
  SELECT
    source.tenant_id,
    source.incident_id,
    source.id AS source_id,
    run.id AS run_id,
    incident.source_workspace_id AS workspace_id,
    source.provider_source_id AS channel_id,
    source.source_kind,
    source.display_name,
    source.requested_start_at,
    source.requested_end_at,
    source.anchor_thread_timestamps,
    source.status,
    checkpoint.phase,
    checkpoint.anchor_index,
    checkpoint.collection_cursor,
    checkpoint.pages_collected,
    checkpoint.collected_message_count,
    checkpoint.rate_limit_count,
    checkpoint.transient_failure_count,
    checkpoint.version AS checkpoint_version,
    COALESCE(incident.evidence_retention_days, 30) AS retention_days
  FROM incident_sources source
  JOIN incidents incident
    ON incident.tenant_id = source.tenant_id
   AND incident.id = source.incident_id
  JOIN source_collection_runs run
    ON run.tenant_id = source.tenant_id
   AND run.incident_id = source.incident_id
   AND run.source_id = source.id
   AND run.run_version = 1
  JOIN source_collection_checkpoints checkpoint
    ON checkpoint.tenant_id = run.tenant_id
   AND checkpoint.incident_id = run.incident_id
   AND checkpoint.source_id = run.source_id
   AND checkpoint.run_id = run.id
  WHERE source.tenant_id = $1
    AND source.incident_id = $2
    AND source.id = $3
  LIMIT 1
`;

export class PostgresIncidentSourceCollectionRepository implements IncidentSourceCollectionRepository {
  public constructor(private readonly pool: Pool) {}

  public async getOrCreate(
    tenantId: string,
    incidentId: string,
    sourceId: string,
    runId: string,
    now: Date,
  ): Promise<IncidentSourceCollection> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const source = await client.query<{
        readonly source_kind: 'SLACK_CHANNEL' | 'SLACK_THREAD';
        readonly requested_start_at: Date | string;
        readonly requested_end_at: Date | string;
        readonly status: IncidentSourceStatus;
      }>(
        `
          SELECT source_kind, requested_start_at, requested_end_at, status
          FROM incident_sources
          WHERE tenant_id = $1 AND incident_id = $2 AND id = $3
          FOR UPDATE
        `,
        [tenantId, incidentId, sourceId],
      );
      const configured = source.rows[0];
      if (configured === undefined) {
        throw new IncidentSourceCollectionConfigurationError(
          'Incident source was not found',
        );
      }
      await client.query(
        `
          INSERT INTO source_collection_runs (
            id, tenant_id, incident_id, source_id, run_version,
            idempotency_identity, status, requested_start_at,
            requested_end_at, started_at, updated_at
          )
          VALUES ($1, $2, $3, $4, 1, $5, 'COLLECTING', $6, $7, $8, $8)
          ON CONFLICT (tenant_id, incident_id, source_id, run_version) DO NOTHING
        `,
        [
          runId,
          tenantId,
          incidentId,
          sourceId,
          `${sourceId}:collection:1`,
          configured.requested_start_at,
          configured.requested_end_at,
          now,
        ],
      );
      const run = await client.query<{ readonly id: string }>(
        `
          SELECT id FROM source_collection_runs
          WHERE tenant_id = $1 AND incident_id = $2 AND source_id = $3 AND run_version = 1
          LIMIT 1
        `,
        [tenantId, incidentId, sourceId],
      );
      const persistedRunId = run.rows[0]?.id;
      if (persistedRunId === undefined) {
        throw new IncidentSourceCollectionConfigurationError(
          'Source collection run was not found after creation',
        );
      }
      await client.query(
        `
          INSERT INTO source_collection_checkpoints (
            tenant_id, incident_id, source_id, run_id, phase, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (tenant_id, incident_id, source_id, run_id) DO NOTHING
        `,
        [
          tenantId,
          incidentId,
          sourceId,
          persistedRunId,
          configured.source_kind === 'SLACK_THREAD'
            ? 'ANCHOR_THREAD'
            : 'CHANNEL',
          now,
        ],
      );
      await client.query(
        `
          UPDATE incident_sources
          SET status = 'COLLECTING', updated_at = $1, version = version + 1
          WHERE tenant_id = $2 AND incident_id = $3 AND id = $4 AND status = 'PLANNED'
        `,
        [now, tenantId, incidentId, sourceId],
      );
      await client.query(
        `
          INSERT INTO source_coverage_manifests (
            tenant_id, incident_id, source_id, manifest_version, source_state,
            requested_start_at, requested_end_at, updated_at
          )
          VALUES ($1, $2, $3, 1, 'COLLECTING', $4, $5, $6)
          ON CONFLICT (tenant_id, incident_id, source_id, manifest_version) DO NOTHING
        `,
        [
          tenantId,
          incidentId,
          sourceId,
          configured.requested_start_at,
          configured.requested_end_at,
          now,
        ],
      );
      const collection = await client.query<CollectionRow>(COLLECTION_QUERY, [
        tenantId,
        incidentId,
        sourceId,
      ]);
      await client.query('COMMIT');
      return requireCollection(collection.rows);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async advance(
    input: AdvanceIncidentSourceCollectionInput,
  ): Promise<IncidentSourceCollection> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const message of input.messages) {
        await client.query(
          `
            INSERT INTO source_artifacts (
              id, tenant_id, incident_id, source_type, external_id, source_uri,
              author_external_id, occurred_at, observed_at, content,
              content_sha256, metadata, retention_expires_at
            )
            VALUES ($1, $2, $3, 'SLACK_MESSAGE', $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
            ON CONFLICT (tenant_id, incident_id, source_type, external_id) DO UPDATE
            SET source_uri = EXCLUDED.source_uri,
                author_external_id = EXCLUDED.author_external_id,
                occurred_at = EXCLUDED.occurred_at,
                observed_at = EXCLUDED.observed_at,
                content = EXCLUDED.content,
                content_sha256 = EXCLUDED.content_sha256,
                metadata = source_artifacts.metadata || EXCLUDED.metadata,
                retention_expires_at = EXCLUDED.retention_expires_at
            WHERE source_artifacts.deleted_at IS NULL
          `,
          [
            message.id,
            input.collection.tenantId,
            input.collection.incidentId,
            message.externalId,
            message.sourceUri,
            message.authorExternalId ?? null,
            message.occurredAt,
            message.observedAt,
            message.content,
            message.contentSha256,
            JSON.stringify(message.metadata),
            message.retentionExpiresAt,
          ],
        );
      }
      const count = await client.query<{ readonly count: number }>(
        `
          SELECT count(*)::integer AS count
          FROM source_artifacts
          WHERE tenant_id = $1 AND incident_id = $2
            AND source_type = 'SLACK_MESSAGE' AND deleted_at IS NULL
            AND metadata->>'sourceId' = $3
        `,
        [
          input.collection.tenantId,
          input.collection.incidentId,
          input.collection.sourceId,
        ],
      );
      const messageCount = count.rows[0]?.count;
      if (messageCount === undefined) {
        throw new IncidentSourceCollectionConfigurationError(
          'PostgreSQL did not return the source artifact count',
        );
      }
      const checkpoint = await client.query(
        `
          UPDATE source_collection_checkpoints
          SET phase = $1,
              anchor_index = $2,
              collection_cursor = $3,
              pages_collected = pages_collected + 1,
              collected_message_count = $4,
              last_collected_at = COALESCE($5, last_collected_at),
              rate_limited_until = NULL,
              updated_at = $6,
              version = version + 1
          WHERE tenant_id = $7 AND incident_id = $8 AND source_id = $9 AND run_id = $10
            AND version = $11 AND phase = $12
            AND collection_cursor IS NOT DISTINCT FROM $13
        `,
        [
          input.nextPhase,
          input.nextAnchorIndex,
          input.nextCursor,
          messageCount,
          latestMessageAt(input.messages),
          input.observedAt,
          input.collection.tenantId,
          input.collection.incidentId,
          input.collection.sourceId,
          input.collection.runId,
          input.collection.checkpointVersion,
          input.collection.phase,
          input.collection.cursor,
        ],
      );
      if (checkpoint.rowCount !== 1) {
        throw new IncidentSourceCollectionConcurrencyError();
      }
      const state = input.completed ? 'COMPLETE' : 'COLLECTING';
      await client.query(
        `
          UPDATE incident_sources
          SET status = $1,
              display_name = COALESCE($2, display_name),
              updated_at = $3,
              version = version + 1
          WHERE tenant_id = $4 AND incident_id = $5 AND id = $6
            AND status = 'COLLECTING'
        `,
        [
          state,
          input.displayName ?? null,
          input.observedAt,
          input.collection.tenantId,
          input.collection.incidentId,
          input.collection.sourceId,
        ],
      );
      await client.query(
        `
          UPDATE source_collection_runs
          SET status = $1,
              collected_message_count = $2,
              permission_outcome = 'ALLOWED',
              completion_reason = $3,
              finished_at = $4,
              updated_at = $5,
              version = version + 1
          WHERE tenant_id = $6 AND incident_id = $7 AND id = $8
        `,
        [
          state,
          messageCount,
          input.completed ? 'WINDOW_COLLECTED' : null,
          input.completed ? input.observedAt : null,
          input.observedAt,
          input.collection.tenantId,
          input.collection.incidentId,
          input.collection.runId,
        ],
      );
      await client.query(
        `
          UPDATE source_coverage_manifests
          SET source_state = $1,
              collected_message_count = $2,
              permission_outcome = 'ALLOWED',
              completion_or_failure_reason = $3,
              updated_at = $4
          WHERE tenant_id = $5 AND incident_id = $6 AND source_id = $7 AND manifest_version = 1
        `,
        [
          state,
          messageCount,
          input.completed ? 'WINDOW_COLLECTED' : null,
          input.observedAt,
          input.collection.tenantId,
          input.collection.incidentId,
          input.collection.sourceId,
        ],
      );
      const persisted = await client.query<CollectionRow>(COLLECTION_QUERY, [
        input.collection.tenantId,
        input.collection.incidentId,
        input.collection.sourceId,
      ]);
      await client.query('COMMIT');
      return requireCollection(persisted.rows);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordRateLimit(
    collection: IncidentSourceCollection,
    retryAfterSeconds: number,
    now: Date,
  ): Promise<IncidentSourceCollection> {
    const limitedUntil = new Date(now.getTime() + retryAfterSeconds * 1_000);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `
          UPDATE source_collection_checkpoints
          SET rate_limit_count = rate_limit_count + 1,
              rate_limited_until = $1,
              updated_at = $2,
              version = version + 1
          WHERE tenant_id = $3 AND incident_id = $4 AND source_id = $5 AND run_id = $6
            AND version = $7
        `,
        [
          limitedUntil,
          now,
          collection.tenantId,
          collection.incidentId,
          collection.sourceId,
          collection.runId,
          collection.checkpointVersion,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new IncidentSourceCollectionConcurrencyError();
      }
      const rateState = JSON.stringify({
        retryAfterSeconds,
        limitedUntil: limitedUntil.toISOString(),
      });
      await client.query(
        `
          UPDATE source_collection_runs
          SET provider_rate_limit_state = $1::jsonb, updated_at = $2, version = version + 1
          WHERE tenant_id = $3 AND incident_id = $4 AND id = $5
        `,
        [
          rateState,
          now,
          collection.tenantId,
          collection.incidentId,
          collection.runId,
        ],
      );
      await client.query(
        `
          UPDATE source_coverage_manifests
          SET provider_rate_limit_state = $1::jsonb, updated_at = $2
          WHERE tenant_id = $3 AND incident_id = $4 AND source_id = $5 AND manifest_version = 1
        `,
        [
          rateState,
          now,
          collection.tenantId,
          collection.incidentId,
          collection.sourceId,
        ],
      );
      const persisted = await client.query<CollectionRow>(COLLECTION_QUERY, [
        collection.tenantId,
        collection.incidentId,
        collection.sourceId,
      ]);
      await client.query('COMMIT');
      return requireCollection(persisted.rows);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordTransientFailure(
    collection: IncidentSourceCollection,
    reason: string,
    retryAfterSeconds: number,
    now: Date,
  ): Promise<IncidentSourceCollection> {
    const retryAt = new Date(now.getTime() + retryAfterSeconds * 1_000);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `
          UPDATE source_collection_checkpoints
          SET transient_failure_count = transient_failure_count + 1,
              updated_at = $1,
              version = version + 1
          WHERE tenant_id = $2 AND incident_id = $3 AND source_id = $4 AND run_id = $5
            AND version = $6
        `,
        [
          now,
          collection.tenantId,
          collection.incidentId,
          collection.sourceId,
          collection.runId,
          collection.checkpointVersion,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new IncidentSourceCollectionConcurrencyError();
      }
      const providerState = JSON.stringify({
        transientFailure: reason,
        retryAt: retryAt.toISOString(),
      });
      await client.query(
        `
          UPDATE source_collection_runs
          SET provider_rate_limit_state = provider_rate_limit_state || $1::jsonb,
              updated_at = $2, version = version + 1
          WHERE tenant_id = $3 AND incident_id = $4 AND id = $5
        `,
        [
          providerState,
          now,
          collection.tenantId,
          collection.incidentId,
          collection.runId,
        ],
      );
      await client.query(
        `
          UPDATE source_coverage_manifests
          SET provider_rate_limit_state = provider_rate_limit_state || $1::jsonb,
              updated_at = $2
          WHERE tenant_id = $3 AND incident_id = $4 AND source_id = $5 AND manifest_version = 1
        `,
        [
          providerState,
          now,
          collection.tenantId,
          collection.incidentId,
          collection.sourceId,
        ],
      );
      const persisted = await client.query<CollectionRow>(COLLECTION_QUERY, [
        collection.tenantId,
        collection.incidentId,
        collection.sourceId,
      ]);
      await client.query('COMMIT');
      return requireCollection(persisted.rows);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async finish(
    input: FinishIncidentSourceCollectionInput,
  ): Promise<IncidentSourceCollection> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const missingPeriods = JSON.stringify([
        {
          start: input.collection.requestedStartAt.toISOString(),
          end: input.collection.requestedEndAt.toISOString(),
          reason: input.reason,
        },
      ]);
      const updated = await client.query(
        `
          UPDATE source_collection_checkpoints
          SET phase = 'COMPLETE', collection_cursor = NULL,
              updated_at = $1, version = version + 1
          WHERE tenant_id = $2 AND incident_id = $3 AND source_id = $4 AND run_id = $5
            AND version = $6
        `,
        [
          input.finishedAt,
          input.collection.tenantId,
          input.collection.incidentId,
          input.collection.sourceId,
          input.collection.runId,
          input.collection.checkpointVersion,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new IncidentSourceCollectionConcurrencyError();
      }
      await client.query(
        `
          UPDATE incident_sources
          SET status = $1, updated_at = $2, version = version + 1
          WHERE tenant_id = $3 AND incident_id = $4 AND id = $5 AND status = 'COLLECTING'
        `,
        [
          input.status,
          input.finishedAt,
          input.collection.tenantId,
          input.collection.incidentId,
          input.collection.sourceId,
        ],
      );
      await client.query(
        `
          UPDATE source_collection_runs
          SET status = $1, permission_outcome = $2,
              missing_or_excluded_periods = $3::jsonb,
              completion_reason = $4, failure_reason = $4,
              finished_at = $5, updated_at = $5, version = version + 1
          WHERE tenant_id = $6 AND incident_id = $7 AND id = $8
        `,
        [
          input.status,
          input.permissionOutcome,
          missingPeriods,
          input.reason,
          input.finishedAt,
          input.collection.tenantId,
          input.collection.incidentId,
          input.collection.runId,
        ],
      );
      await client.query(
        `
          UPDATE source_coverage_manifests
          SET source_state = $1, permission_outcome = $2,
              missing_or_excluded_periods = $3::jsonb,
              completion_or_failure_reason = $4, updated_at = $5
          WHERE tenant_id = $6 AND incident_id = $7 AND source_id = $8 AND manifest_version = 1
        `,
        [
          input.status,
          input.permissionOutcome,
          missingPeriods,
          input.reason,
          input.finishedAt,
          input.collection.tenantId,
          input.collection.incidentId,
          input.collection.sourceId,
        ],
      );
      const persisted = await client.query<CollectionRow>(COLLECTION_QUERY, [
        input.collection.tenantId,
        input.collection.incidentId,
        input.collection.sourceId,
      ]);
      await client.query('COMMIT');
      return requireCollection(persisted.rows);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

function requireCollection(
  rows: readonly CollectionRow[],
): IncidentSourceCollection {
  const row = rows[0];
  if (row === undefined) {
    throw new IncidentSourceCollectionConfigurationError(
      'Source collection checkpoint was not found',
    );
  }
  return {
    tenantId: row.tenant_id,
    incidentId: row.incident_id,
    sourceId: row.source_id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    sourceKind: row.source_kind,
    displayName: row.display_name,
    requestedStartAt: toDate(row.requested_start_at),
    requestedEndAt: toDate(row.requested_end_at),
    anchorThreadTimestamps: row.anchor_thread_timestamps,
    status: row.status,
    phase: row.phase,
    anchorIndex: row.anchor_index,
    cursor: row.collection_cursor,
    pagesCollected: row.pages_collected,
    messagesCollected: row.collected_message_count,
    rateLimitCount: row.rate_limit_count,
    transientFailureCount: row.transient_failure_count,
    checkpointVersion: row.checkpoint_version,
    retentionDays: row.retention_days,
  };
}

function latestMessageAt(
  messages: AdvanceIncidentSourceCollectionInput['messages'],
): Date | null {
  return messages.reduce<Date | null>(
    (latest, message) =>
      latest === null || message.occurredAt > latest
        ? message.occurredAt
        : latest,
    null,
  );
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new IncidentSourceCollectionConfigurationError(
      'PostgreSQL returned an invalid source timestamp',
    );
  }
  return date;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original persistence failure.
  }
}
