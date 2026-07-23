import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const websiteRoot = new URL('../', import.meta.url);

test('uploads the verified artifact and waits for invalidation', async () => {
  const fixture = await createMockAws();

  await execFile('bash', ['scripts/upload-s3-cloudfront.sh'], {
    cwd: websiteRoot,
    env: {
      ...process.env,
      PATH: `${fixture.binDirectory}:${process.env.PATH}`,
      AWS_CALL_LOG: fixture.logPath,
      S3_BUCKET: 'onrecord-public-site-prod',
      CLOUDFRONT_DISTRIBUTION_ID: 'E3EMVCLM5MIYJP',
    },
  });

  const calls = await readFile(fixture.logPath, 'utf8');
  assert.match(calls, /sts get-caller-identity/);
  assert.match(calls, /s3 sync out s3:\/\/onrecord-public-site-prod/);
  assert.match(calls, /cloudfront create-invalidation/);
  assert.match(calls, /cloudfront wait invalidation-completed/);
  assert.match(calls, /--id INV-TEST-123/);
});

test('rejects an invalid bucket before contacting AWS', async () => {
  const fixture = await createMockAws();

  await assert.rejects(
    execFile('bash', ['scripts/upload-s3-cloudfront.sh'], {
      cwd: websiteRoot,
      env: {
        ...process.env,
        PATH: `${fixture.binDirectory}:${process.env.PATH}`,
        AWS_CALL_LOG: fixture.logPath,
        S3_BUCKET: 'Invalid Bucket',
        CLOUDFRONT_DISTRIBUTION_ID: 'E3EMVCLM5MIYJP',
      },
    }),
    /S3_BUCKET is not a valid bucket name/,
  );

  const calls = await readFile(fixture.logPath, 'utf8');
  assert.equal(calls, '');
});

async function createMockAws() {
  const fixtureDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'onrecord-aws-test-'),
  );
  const binDirectory = path.join(fixtureDirectory, 'bin');
  const logPath = path.join(fixtureDirectory, 'aws-calls.log');
  await mkdir(binDirectory);
  await writeFile(logPath, '');
  await writeFile(
    path.join(binDirectory, 'aws'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$AWS_CALL_LOG"
if [[ "$1 $2" == "cloudfront create-invalidation" ]]; then
  printf '%s\\n' 'INV-TEST-123'
fi
`,
    { mode: 0o700 },
  );

  return { binDirectory, logPath };
}
