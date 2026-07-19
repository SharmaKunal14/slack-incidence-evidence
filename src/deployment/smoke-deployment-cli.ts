import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { readReleaseManifest } from './release-manifest.js';
import { smokeAwsDeployment } from './smoke-deployment.js';

const environment = z
  .object({
    AWS_REGION: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/),
    TERRAFORM_OUTPUTS_PATH: z.string().min(1).max(4_096),
  })
  .parse(process.env);
const contents = await readFile(environment.TERRAFORM_OUTPUTS_PATH, 'utf8');
if (contents.length > 10 * 1_024 * 1_024) {
  throw new Error('Terraform outputs exceed the ten-megabyte smoke-test limit');
}
let outputs: unknown;
try {
  outputs = JSON.parse(contents) as unknown;
} catch {
  throw new Error('Terraform outputs are not valid JSON');
}
const manifest = await readReleaseManifest(
  resolve(process.cwd(), 'artifacts/release-manifest.json'),
);
const reviewArtifacts = Object.fromEntries(
  manifest.reviewWeb.files.map((artifact) => [
    artifact.path.replace(/^review-web\//u, ''),
    artifact.sha256,
  ]),
);
const result = await smokeAwsDeployment(
  outputs,
  environment.AWS_REGION,
  manifest.lambda.sha256,
  reviewArtifacts,
);
const githubOutput = process.env['GITHUB_OUTPUT'];
if (githubOutput !== undefined && githubOutput.length > 0) {
  await appendFile(githubOutput, `url=${result.reviewConsoleUrl}\n`, 'utf8');
}
process.stdout.write('AWS deployment smoke checks passed\n');
