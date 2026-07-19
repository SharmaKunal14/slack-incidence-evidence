import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReleaseManifest } from '../../src/deployment/release-manifest.js';

const temporaryDirectories: string[] = [];

async function releaseFixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'incident-release-test-'));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(resolve(root, 'artifacts/review-web'), { recursive: true }),
    mkdir(resolve(root, 'db/migrations'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(root, 'artifacts/incident-copilot-lambda.zip'), 'lambda'),
    writeFile(resolve(root, 'artifacts/review-web/app.js'), 'application'),
    writeFile(
      resolve(root, 'artifacts/review-web/index.html'),
      '<main></main>',
    ),
    writeFile(resolve(root, 'artifacts/review-web/styles.css'), 'main {}'),
    writeFile(resolve(root, 'db/migrations/0001_initial.sql'), 'SELECT 1;'),
    writeFile(resolve(root, 'db/migrations/0002_second.sql'), 'SELECT 2;'),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('release manifest', () => {
  it('binds the commit to deterministic application and migration digests', async () => {
    const root = await releaseFixture();
    const manifest = await createReleaseManifest(root, 'a'.repeat(40));

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      commitSha: 'a'.repeat(40),
      lambda: { path: 'incident-copilot-lambda.zip' },
      database: { latestMigrationVersion: 2 },
    });
    expect(manifest.reviewWeb.files.map(({ path }) => path)).toEqual([
      'review-web/app.js',
      'review-web/index.html',
      'review-web/styles.css',
    ]);
    expect(manifest.lambda.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects migration gaps and unexpected web release files', async () => {
    const migrationRoot = await releaseFixture();
    await rm(resolve(migrationRoot, 'db/migrations/0001_initial.sql'));
    await expect(
      createReleaseManifest(migrationRoot, 'b'.repeat(40)),
    ).rejects.toThrow('contiguous');

    const webRoot = await releaseFixture();
    await writeFile(resolve(webRoot, 'artifacts/review-web/source.map'), '{}');
    await expect(
      createReleaseManifest(webRoot, 'c'.repeat(40)),
    ).rejects.toThrow('unexpected or missing files');
  });
});
