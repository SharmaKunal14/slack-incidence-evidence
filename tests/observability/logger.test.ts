import { describe, expect, it } from 'vitest';
import { serializeError } from '../../src/observability/logger.js';

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
});
