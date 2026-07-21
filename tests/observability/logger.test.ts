import { describe, expect, it } from 'vitest';
import { serializeError } from '../../src/observability/logger.js';
import { DatabaseSchemaCompatibilityError } from '../../src/infrastructure/postgres/schema-compatibility.js';

describe('serializeError', () => {
  it('does not copy sensitive error messages or stacks into normal logs', () => {
    const error = Object.assign(
      new Error('Slack message contained customer-secret-123'),
      { code: 'UPSTREAM_FAILURE' },
    );

    const serialized = serializeError(error);
    expect(serialized).toEqual({
      type: 'Error',
      code: 'UPSTREAM_FAILURE',
    });
    expect(JSON.stringify(serialized)).not.toContain('customer-secret-123');
  });

  it('retains an allowlisted PostgreSQL constraint identifier for diagnosis', () => {
    const error = Object.assign(new Error('sensitive database detail'), {
      code: '23514',
      constraint: 'source_collection_runs_updated_after_creation',
    });

    expect(serializeError(error)).toEqual({
      type: 'Error',
      code: '23514',
      constraint: 'source_collection_runs_updated_after_creation',
    });
  });

  it('retains a content-safe schema compatibility diagnostic code', () => {
    expect(
      serializeError(
        new DatabaseSchemaCompatibilityError('SCHEMA_MIGRATION_COUNT_MISMATCH'),
      ),
    ).toEqual({
      type: 'DatabaseSchemaCompatibilityError',
      code: 'SCHEMA_MIGRATION_COUNT_MISMATCH',
    });
  });
});
