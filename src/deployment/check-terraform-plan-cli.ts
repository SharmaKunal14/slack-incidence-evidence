import { assessTerraformPlan } from './terraform-plan-policy.js';

const maximumPlanBytes = 50 * 1_024 * 1_024;
const chunks: Buffer[] = [];
let receivedBytes = 0;
for await (const chunk of process.stdin) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
  receivedBytes += buffer.length;
  if (receivedBytes > maximumPlanBytes) {
    throw new Error('Terraform plan JSON exceeds the 50-megabyte policy limit');
  }
  chunks.push(buffer);
}
const contents = Buffer.concat(chunks).toString('utf8');
let plan: unknown;
try {
  plan = JSON.parse(contents) as unknown;
} catch {
  throw new Error('Terraform plan output is not valid JSON');
}
const assessment = assessTerraformPlan(plan);
process.stdout.write(
  `Terraform plan policy: ${assessment.createCount} create, ${assessment.updateCount} update, ${assessment.deleteCount} delete\n`,
);
if (assessment.destructiveAddresses.length > 0) {
  process.stderr.write(
    `Automatic deployment blocks destructive changes:\n${assessment.destructiveAddresses.map((address) => `- ${address}`).join('\n')}\n`,
  );
  process.exitCode = 1;
}
