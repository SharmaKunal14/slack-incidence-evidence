import type { Pool, PoolClient } from 'pg';
import {
  SlackThreadCollectionConcurrencyError,
  SlackThreadCollectionConfigurationError,
  type FailSlackThreadCollectionInput,
  type SaveSlackThreadPageInput,
  type SlackThreadCollection,
  type SlackThreadCollectionRepository,
  type SlackThreadCollectionStatus,
} from '../../application/ports/slack-thread-collection-repository.js';

interface IncidentSourceRow {
  readonly source_workspace_id: string;
  readonly source_channel_id: string;
  readonly source_message_ts: string | null;
  readonly source_thread_ts: string | null;
}

interface CollectionRow {
  readonly tenant_id: string;
  readonly incident_id: string;
  readonly workspace_id: string;
  readonly channel_id: string;
  readonly thread_ts: string;
  readonly status: SlackThreadCollectionStatus;
  readonly next_cursor: string | null;
  readonly messages_collected: number;
  readonly pages_collected: number;
  readonly failure_code: string | null;
  readonly version: number;
}

interface CountRow {
  readonly count: number;
}

const COLLECTION_COLUMNS = `
  tenant_id,
  incident_id,
  workspace_id,
  channel_id,
  thread_ts,
  status,
  next_cursor,
  messages_collected,
  pages_collected,
  failure_code,
  version
`;

/** PostgreSQL checkpoint and idempotent Slack artifact persistence. */
export class PostgresSlackThreadCollectionRepository implements SlackThreadCollectionRepository {
  public constructor(private readonly pool: Pool) {}

  public async getOrCreate(
    tenantId: string,
    incidentId: string,
  ): Promise<SlackThreadCollection> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const incident = await client.query<IncidentSourceRow>(
        `
          SELECT
            source_workspace_id,
            source_channel_id,
            source_message_ts,
            source_thread_ts
          FROM incidents
          WHERE tenant_id = $1
            AND id = $2
          LIMIT 1
        `,
        [tenantId, incidentId],
      );
      const source = incident.rows[0];
      if (source === undefined) {
        throw new SlackThreadCollectionConfigurationError(
          'Incident was not found for Slack thread collection',
        );
      }
      const threadTs = source.source_thread_ts ?? source.source_message_ts;
      if (threadTs === null) {
        throw new SlackThreadCollectionConfigurationError(
          'Incident predates persisted Slack source message timestamps',
        );
      }
      if (source.source_workspace_id !== tenantId) {
        throw new SlackThreadCollectionConfigurationError(
          'Incident workspace does not match its tenant',
        );
      }

      await client.query(
        `
          INSERT INTO slack_thread_collections (
            tenant_id,
            incident_id,
            workspace_id,
            channel_id,
            thread_ts
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (tenant_id, incident_id) DO NOTHING
        `,
        [
          tenantId,
          incidentId,
          source.source_workspace_id,
          source.source_channel_id,
          threadTs,
        ],
      );
      const collection = await client.query<CollectionRow>(
        `
          SELECT ${COLLECTION_COLUMNS}
          FROM slack_thread_collections
          WHERE tenant_id = $1
            AND incident_id = $2
          LIMIT 1
        `,
        [tenantId, incidentId],
      );
      const persisted = requireCollection(collection.rows);
      await client.query('COMMIT');
      return persisted;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async savePage(
    input: SaveSlackThreadPageInput,
  ): Promise<SlackThreadCollection> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const message of input.messages) {
        await client.query(
          `
            INSERT INTO source_artifacts (
              id,
              tenant_id,
              incident_id,
              source_type,
              external_id,
              source_uri,
              author_external_id,
              occurred_at,
              observed_at,
              content,
              content_sha256,
              metadata,
              retention_expires_at
            )
            VALUES (
              $1, $2, $3, 'SLACK_MESSAGE', $4, $5, $6,
              $7, $8, $9, $10, $11::jsonb, $12
            )
            ON CONFLICT (
              tenant_id,
              incident_id,
              source_type,
              external_id
            ) DO UPDATE
            SET source_uri = EXCLUDED.source_uri,
                author_external_id = EXCLUDED.author_external_id,
                occurred_at = EXCLUDED.occurred_at,
                observed_at = EXCLUDED.observed_at,
                content = EXCLUDED.content,
                content_sha256 = EXCLUDED.content_sha256,
                metadata = EXCLUDED.metadata,
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

      const count = await client.query<CountRow>(
        `
          SELECT count(*)::integer AS count
          FROM source_artifacts
          WHERE tenant_id = $1
            AND incident_id = $2
            AND source_type = 'SLACK_MESSAGE'
            AND deleted_at IS NULL
            AND metadata->>'collectionType' = 'SLACK_THREAD'
            AND metadata->>'threadTs' = $3
        `,
        [
          input.collection.tenantId,
          input.collection.incidentId,
          input.collection.threadTs,
        ],
      );
      const messagesCollected = count.rows[0]?.count;
      if (messagesCollected === undefined) {
        throw new SlackThreadCollectionConfigurationError(
          'PostgreSQL did not return the Slack artifact count',
        );
      }

      const complete = input.nextCursor === null;
      const updated = await client.query<CollectionRow>(
        `
          UPDATE slack_thread_collections
          SET status = $1,
              next_cursor = $2,
              messages_collected = $3,
              pages_collected = pages_collected + 1,
              updated_at = $4,
              finished_at = $5,
              version = version + 1
          WHERE tenant_id = $6
            AND incident_id = $7
            AND status = 'RUNNING'
            AND version = $8
            AND next_cursor IS NOT DISTINCT FROM $9
          RETURNING ${COLLECTION_COLUMNS}
        `,
        [
          complete ? 'COMPLETE' : 'RUNNING',
          input.nextCursor,
          messagesCollected,
          input.observedAt,
          complete ? input.observedAt : null,
          input.collection.tenantId,
          input.collection.incidentId,
          input.collection.version,
          input.collection.nextCursor,
        ],
      );
      const persisted = updated.rows[0];
      if (persisted === undefined) {
        throw new SlackThreadCollectionConcurrencyError();
      }
      await client.query('COMMIT');
      return toCollection(persisted);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async fail(
    input: FailSlackThreadCollectionInput,
  ): Promise<SlackThreadCollection> {
    const result = await this.pool.query<CollectionRow>(
      `
        UPDATE slack_thread_collections
        SET status = 'FAILED',
            failure_code = $1,
            updated_at = $2,
            finished_at = $2,
            version = version + 1
        WHERE tenant_id = $3
          AND incident_id = $4
          AND status = 'RUNNING'
          AND version = $5
          AND next_cursor IS NOT DISTINCT FROM $6
        RETURNING ${COLLECTION_COLUMNS}
      `,
      [
        input.failureCode,
        input.failedAt,
        input.collection.tenantId,
        input.collection.incidentId,
        input.collection.version,
        input.collection.nextCursor,
      ],
    );
    const persisted = result.rows[0];
    if (persisted === undefined) {
      throw new SlackThreadCollectionConcurrencyError();
    }
    return toCollection(persisted);
  }
}

function toCollection(row: CollectionRow): SlackThreadCollection {
  return {
    tenantId: row.tenant_id,
    incidentId: row.incident_id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    status: row.status,
    nextCursor: row.next_cursor,
    messagesCollected: row.messages_collected,
    pagesCollected: row.pages_collected,
    failureCode: row.failure_code,
    version: row.version,
  };
}

function requireCollection(
  rows: readonly CollectionRow[],
): SlackThreadCollection {
  const row = rows[0];
  if (row === undefined) {
    throw new SlackThreadCollectionConfigurationError(
      'Slack thread collection checkpoint was not found after creation',
    );
  }
  return toCollection(row);
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original database failure. PostgreSQL releases an open
    // transaction when the failed connection is discarded.
  }
}
