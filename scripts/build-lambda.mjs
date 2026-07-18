import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const executeFile = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const artifactsDirectory = fileURLToPath(
  new URL('../artifacts/', import.meta.url),
);
const stagingDirectory = fileURLToPath(
  new URL('../artifacts/lambda/', import.meta.url),
);
const archivePath = fileURLToPath(
  new URL('../artifacts/incident-copilot-lambda.zip', import.meta.url),
);

await rm(stagingDirectory, { force: true, recursive: true });
await rm(archivePath, { force: true });
await mkdir(stagingDirectory, { recursive: true });

await build({
  absWorkingDir: projectRoot,
  bundle: true,
  entryPoints: {
    'incident-analysis-main': 'src/lambda/incident-analysis-main.ts',
    'incident-report-main': 'src/lambda/incident-report-main.ts',
    'incident-review-notification-main':
      'src/lambda/incident-review-notification-main.ts',
    'incident-worker-main': 'src/lambda/incident-worker-main.ts',
    'slack-evidence-collector-main':
      'src/lambda/slack-evidence-collector-main.ts',
    'slack-ingress-main': 'src/lambda/slack-ingress-main.ts',
  },
  entryNames: '[name]',
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'warning',
  minify: false,
  outdir: stagingDirectory,
  outExtension: { '.js': '.js' },
  platform: 'node',
  sourcemap: false,
  target: 'node22',
  treeShaking: true,
});

await writeFile(
  join(stagingDirectory, 'package.json'),
  `${JSON.stringify({ type: 'commonjs' })}\n`,
  'utf8',
);

const bundleFiles = (await readdir(stagingDirectory)).sort();
const expectedBundleFiles = [
  'incident-analysis-main.js',
  'incident-report-main.js',
  'incident-review-notification-main.js',
  'incident-worker-main.js',
  'package.json',
  'slack-evidence-collector-main.js',
  'slack-ingress-main.js',
];
if (JSON.stringify(bundleFiles) !== JSON.stringify(expectedBundleFiles)) {
  throw new Error(`Unexpected Lambda bundle files: ${bundleFiles.join(', ')}`);
}

// Execute the generated CommonJS modules before archiving them. TypeScript and
// esbuild can both succeed while a bundled CommonJS dependency is unusable from
// an ESM artifact, so this is a runtime-format smoke test rather than a file
// existence check.
await executeFile(
  process.execPath,
  [
    '-e',
    "const ingress = require('./slack-ingress-main.js'); const worker = require('./incident-worker-main.js'); const collector = require('./slack-evidence-collector-main.js'); const analysis = require('./incident-analysis-main.js'); const report = require('./incident-report-main.js'); const notification = require('./incident-review-notification-main.js'); if (typeof ingress.handler !== 'function' || typeof worker.handler !== 'function' || typeof collector.handler !== 'function' || typeof analysis.handler !== 'function' || typeof report.handler !== 'function' || typeof notification.handler !== 'function') throw new Error('Lambda handler export missing');",
  ],
  {
    cwd: stagingDirectory,
    env: {
      ...process.env,
      DATABASE_HOST: 'database.example.test',
      DATABASE_NAME: 'incident_copilot',
      DATABASE_SECRET_ARN: 'test-database-secret',
      ANALYSIS_LEASE_SECONDS: '180',
      OPENAI_API_SECRET_ARN: 'test-openai-secret',
      OPENAI_MODEL: 'test-model',
      OPENAI_TIMEOUT_MS: '90000',
      OPENAI_REPORT_TIMEOUT_MS: '90000',
      REPORT_LEASE_SECONDS: '180',
      EVIDENCE_RETENTION_DAYS: '30',
      INCIDENT_QUEUE_URL: 'https://sqs.example.test/incident-jobs.fifo',
      INCIDENT_WORKFLOW_STATE_MACHINE_ARN: 'test-state-machine',
      SLACK_BOT_TOKEN_SECRET_ARN: 'test-slack-bot-secret',
      SLACK_THREAD_MAX_PAGES: '100',
      SLACK_SIGNING_SECRET_ARN: 'test-slack-secret',
    },
  },
);

// Stable entry timestamps plus stripped ZIP metadata keep the artifact digest
// unchanged when source and dependencies are unchanged.
const stableTimestamp = new Date('2000-01-01T00:00:00.000Z');
await Promise.all(
  bundleFiles.map((file) =>
    utimes(join(stagingDirectory, file), stableTimestamp, stableTimestamp),
  ),
);

await mkdir(artifactsDirectory, { recursive: true });
await executeFile('zip', ['-q', '-9', '-X', archivePath, ...bundleFiles], {
  cwd: stagingDirectory,
  env: { ...process.env, TZ: 'UTC' },
});

process.stdout.write(`Created ${archivePath}\n`);
