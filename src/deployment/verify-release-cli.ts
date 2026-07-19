import { resolve } from 'node:path';
import {
  createReleaseManifest,
  readReleaseManifest,
} from './release-manifest.js';

const projectRoot = process.cwd();
const manifestPath = resolve(projectRoot, 'artifacts/release-manifest.json');
const manifest = await readReleaseManifest(manifestPath);
const expectedCommitSha = (process.env['GITHUB_SHA'] ?? manifest.commitSha)
  .trim()
  .toLowerCase();
const expected = await createReleaseManifest(projectRoot, expectedCommitSha);

if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
  throw new Error('Release artifact digest verification failed');
}
process.stdout.write(
  `Verified release ${manifest.commitSha} (${manifest.lambda.sha256})\n`,
);
