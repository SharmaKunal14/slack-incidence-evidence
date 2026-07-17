import type { Pool, PoolClient } from 'pg';
import {
  OptimisticConcurrencyError,
  type CreateIncidentResult,
  type IncidentRepository,
} from '../../application/ports/incident-repository.js';
import type {
  Incident,
  IncidentSeverity,
  IncidentStatus,
} from '../../domain/incident.js';

interface IncidentRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly source_event_id: string;
  readonly source_workspace_id: string;
  readonly source_channel_id: string;
  readonly source_thread_ts: string | null;
  readonly requested_by_user_id: string;
  readonly title: string;
  readonly status: IncidentStatus;
  readonly severity: IncidentSeverity;
  readonly started_at: Date | string | null;
  readonly resolved_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly version: number;
}

const INCIDENT_COLUMNS = `
  id,
  tenant_id,
  source_event_id,
  source_workspace_id,
  source_channel_id,
  source_thread_ts,
  requested_by_user_id,
  title,
  status,
  severity,
  started_at,
  resolved_at,
  created_at,
  updated_at,
  version
`;

export class IncidentPersistenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IncidentPersistenceError';
  }
}

function toDate(value: Date | string): Date {
  if (value instanceof Date) {
    return value;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new IncidentPersistenceError(
      `PostgreSQL returned an invalid timestamp: ${value}`,
    );
  }
  return date;
}

function toOptionalDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

function toIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sourceEventId: row.source_event_id,
    sourceWorkspaceId: row.source_workspace_id,
    sourceChannelId: row.source_channel_id,
    ...(row.source_thread_ts === null
      ? {}
      : { sourceThreadTs: row.source_thread_ts }),
    requestedByUserId: row.requested_by_user_id,
    title: row.title,
    status: row.status,
    severity: row.severity,
    startedAt: toOptionalDate(row.started_at),
    resolvedAt: toOptionalDate(row.resolved_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    version: row.version,
  };
}

function requireSingleIncident(
  rows: readonly IncidentRow[],
  context: string,
): Incident {
  const row = rows[0];
  if (row === undefined) {
    throw new IncidentPersistenceError(context);
  }
  return toIncident(row);
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original database error. A failed connection is discarded by
    // pg and PostgreSQL rolls back its open transaction server-side.
  }
}

/**
 * PostgreSQL adapter for the incident aggregate.
 *
 * Every statement includes tenant_id even though incident IDs are globally
 * unique today. That convention is intentional: it makes accidental cross-
 * tenant access visible in review and preserves the isolation boundary if ID
 * generation changes later.
 */
export class PostgresIncidentRepository implements IncidentRepository {
  public constructor(private readonly pool: Pool) {}

  public async createIfAbsent(
    incident: Incident,
  ): Promise<CreateIncidentResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Until the OAuth installation flow owns tenant provisioning, a valid
      // signed Slack event bootstraps its workspace tenant. The tenant boundary
      // remains explicit, and a later installation sync can update its display
      // metadata without changing incident identity.
      await client.query(
        `
          INSERT INTO tenants (id, display_name)
          VALUES ($1, $2)
          ON CONFLICT (id) DO NOTHING
        `,
        [incident.tenantId, `Slack workspace ${incident.sourceWorkspaceId}`],
      );
      const inserted = await client.query<IncidentRow>(
        `
          INSERT INTO incidents (
            id,
            tenant_id,
            source_event_id,
            source_workspace_id,
            source_channel_id,
            source_thread_ts,
            requested_by_user_id,
            title,
            status,
            severity,
            started_at,
            resolved_at,
            created_at,
            updated_at,
            version
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
          )
          ON CONFLICT (tenant_id, source_event_id) DO NOTHING
          RETURNING ${INCIDENT_COLUMNS}
        `,
        [
          incident.id,
          incident.tenantId,
          incident.sourceEventId,
          incident.sourceWorkspaceId,
          incident.sourceChannelId,
          incident.sourceThreadTs ?? null,
          incident.requestedByUserId,
          incident.title,
          incident.status,
          incident.severity,
          incident.startedAt,
          incident.resolvedAt,
          incident.createdAt,
          incident.updatedAt,
          incident.version,
        ],
      );

      const insertedRow = inserted.rows[0];
      if (insertedRow !== undefined) {
        await client.query('COMMIT');
        return { created: true, incident: toIncident(insertedRow) };
      }

      // This is deliberately a second statement. If a concurrent transaction
      // won the unique-key race, READ COMMITTED takes a new snapshot here and
      // can see the committed winner after INSERT ... DO NOTHING returns.
      const existing = await client.query<IncidentRow>(
        `
          SELECT ${INCIDENT_COLUMNS}
          FROM incidents
          WHERE tenant_id = $1
            AND source_event_id = $2
          LIMIT 1
        `,
        [incident.tenantId, incident.sourceEventId],
      );
      const persisted = requireSingleIncident(
        existing.rows,
        'An incident idempotency conflict occurred but the persisted incident was not found',
      );
      await client.query('COMMIT');
      return { created: false, incident: persisted };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(
    incident: Incident,
    expectedVersion: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new IncidentPersistenceError(
        'Expected incident version must be a non-negative integer',
      );
    }
    if (incident.version !== expectedVersion + 1) {
      throw new IncidentPersistenceError(
        `Incident version ${incident.version} must immediately follow expected version ${expectedVersion}`,
      );
    }

    const result = await this.pool.query(
      `
        UPDATE incidents
        SET title = $1,
            status = $2,
            severity = $3,
            started_at = $4,
            resolved_at = $5,
            updated_at = $6,
            version = $7
        WHERE tenant_id = $8
          AND id = $9
          AND version = $10
      `,
      [
        incident.title,
        incident.status,
        incident.severity,
        incident.startedAt,
        incident.resolvedAt,
        incident.updatedAt,
        incident.version,
        incident.tenantId,
        incident.id,
        expectedVersion,
      ],
    );

    if (result.rowCount !== 1) {
      throw new OptimisticConcurrencyError(
        `Incident ${incident.id} in tenant ${incident.tenantId} was modified concurrently`,
      );
    }
  }

  public async findById(
    tenantId: string,
    incidentId: string,
  ): Promise<Incident | null> {
    const result = await this.pool.query<IncidentRow>(
      `
        SELECT ${INCIDENT_COLUMNS}
        FROM incidents
        WHERE tenant_id = $1
          AND id = $2
        LIMIT 1
      `,
      [tenantId, incidentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toIncident(row);
  }

  public async findBySourceEventId(
    tenantId: string,
    sourceEventId: string,
  ): Promise<Incident | null> {
    const result = await this.pool.query<IncidentRow>(
      `
        SELECT ${INCIDENT_COLUMNS}
        FROM incidents
        WHERE tenant_id = $1
          AND source_event_id = $2
        LIMIT 1
      `,
      [tenantId, sourceEventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toIncident(row);
  }
}
