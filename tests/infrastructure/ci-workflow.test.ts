import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function loadWorkflow(): Promise<string> {
  return readFile(resolve('.github/workflows/ci.yml'), 'utf8');
}

describe('CI deployment workflow', () => {
  it('runs only after a commit reaches main', async () => {
    const workflow = await loadWorkflow();

    expect(workflow).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]$/mu);
    expect(workflow).not.toMatch(/^\s+pull_request:/mu);
  });

  it('does not permit the development deployment outside a main push', async () => {
    const workflow = await loadWorkflow();

    expect(workflow).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
  });
});
