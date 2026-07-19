import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createReleaseManifest } from './release-manifest.js';

const executeFile = promisify(execFile);
const projectRoot = process.cwd();
const commitSha =
  process.env['GITHUB_SHA'] ??
  (
    await executeFile('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      timeout: 10_000,
    })
  ).stdout.trim();
const manifest = await createReleaseManifest(projectRoot, commitSha);
const manifestPath = resolve(projectRoot, 'artifacts/release-manifest.json');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
});
process.stdout.write(`Created ${manifestPath}\n`);
