import type { Pool, QueryResultRow } from 'pg';

export const REQUIRED_SCHEMA_MIGRATIONS = [
  { version: '1', name: '0001_initial.sql' },
  { version: '2', name: '0002_slack_thread_collection.sql' },
  { version: '3', name: '0003_incident_analysis.sql' },
  { version: '4', name: '0004_incident_report_drafts.sql' },
  { version: '5', name: '0005_human_review.sql' },
  { version: '6', name: '0006_approved_report_publication.sql' },
  { version: '7', name: '0007_configurable_report_publisher.sql' },
  { version: '8', name: '0008_review_question_answers.sql' },
  { version: '9', name: '0009_multi_channel_incident_sources.sql' },
  { version: '10', name: '0010_auto_discovered_slack_threads.sql' },
] as const;

interface AppliedMigrationRow extends QueryResultRow {
  readonly version: string;
  readonly name: string;
}

export class DatabaseSchemaCompatibilityError extends Error {
  public constructor(
    readonly code:
      | 'SCHEMA_QUERY_FAILED'
      | 'SCHEMA_MIGRATION_COUNT_MISMATCH'
      | 'SCHEMA_MIGRATION_IDENTITY_MISMATCH',
  ) {
    super('Database schema is incompatible with this application release');
    this.name = 'DatabaseSchemaCompatibilityError';
  }
}

/**
 * Fails a database-backed process before it handles work unless every schema
 * migration required by this release is present under its immutable name.
 * Later migrations are allowed so additive migration-before-code deployments
 * do not take the previous release offline during the rollout window.
 */
export async function assertDatabaseSchemaCompatible(
  database: Pick<Pool, 'query'>,
): Promise<void> {
  let rows: readonly AppliedMigrationRow[];
  const latestRequiredVersion =
    REQUIRED_SCHEMA_MIGRATIONS.at(-1)?.version ?? '0';
  try {
    const result = await database.query<AppliedMigrationRow>(
      `
        SELECT version::text, name
        FROM public.schema_migrations
        WHERE version <= $1::bigint
        ORDER BY version
      `,
      [latestRequiredVersion],
    );
    rows = result.rows;
  } catch {
    // Database errors can include SQL or connection details. Composition roots
    // receive one content-safe compatibility error instead.
    throw new DatabaseSchemaCompatibilityError('SCHEMA_QUERY_FAILED');
  }

  if (rows.length !== REQUIRED_SCHEMA_MIGRATIONS.length) {
    throw new DatabaseSchemaCompatibilityError(
      'SCHEMA_MIGRATION_COUNT_MISMATCH',
    );
  }

  for (let index = 0; index < REQUIRED_SCHEMA_MIGRATIONS.length; index += 1) {
    const expected = REQUIRED_SCHEMA_MIGRATIONS[index];
    const applied = rows[index];
    if (
      expected === undefined ||
      applied === undefined ||
      applied.version !== expected.version ||
      applied.name !== expected.name
    ) {
      throw new DatabaseSchemaCompatibilityError(
        'SCHEMA_MIGRATION_IDENTITY_MISMATCH',
      );
    }
  }
}
