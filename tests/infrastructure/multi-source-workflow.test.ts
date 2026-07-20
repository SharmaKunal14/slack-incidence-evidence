import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('multi-source workflow infrastructure', () => {
  it('uses a bounded inline Map and keeps evidence content out of workflow state', async () => {
    const terraform = await readFile(
      resolve('infrastructure/terraform/main.tf'),
      'utf8',
    );

    expect(terraform).toContain('MaxConcurrency = 5');
    expect(terraform).toContain('Mode = "INLINE"');
    expect(terraform).not.toContain('Mode = "DISTRIBUTED"');
    expect(terraform).not.toContain('ItemReader');
    expect(terraform).toContain('include_execution_data = false');
    expect(terraform).toContain('"sourceId.$"   = "$$.Map.Item.Value"');
  });
});
