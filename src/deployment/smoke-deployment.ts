import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';

const executeFile = promisify(execFile);
const terraformOutputSchema = z.record(
  z.string(),
  z.object({
    sensitive: z.boolean(),
    type: z.unknown(),
    value: z.unknown(),
  }),
);
const reviewRuntimeConfigurationSchema = z
  .object({
    apiBaseUrl: z.url(),
    cognitoBaseUrl: z.url(),
    cognitoClientId: z.string().min(1),
    redirectUri: z.url(),
  })
  .strict();

const lambdaOutputNames = [
  'ingress_lambda_name',
  'worker_lambda_name',
  'slack_evidence_collector_lambda_name',
  'incident_analysis_lambda_name',
  'incident_report_lambda_name',
  'incident_review_notification_lambda_name',
  'incident_review_api_lambda_name',
  'approved_report_publication_lambda_name',
] as const;

function requiredStringOutput(
  outputs: z.infer<typeof terraformOutputSchema>,
  name: string,
): string {
  const output = outputs[name];
  if (
    output === undefined ||
    output.sensitive ||
    typeof output.value !== 'string'
  ) {
    throw new Error(`Terraform output ${name} must be a non-sensitive string`);
  }
  return output.value;
}

async function boundedRetry(
  operation: () => Promise<void>,
  description: string,
): Promise<void> {
  const delays = [0, 1_000, 2_000, 4_000, 8_000];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${description} did not become healthy`, {
    cause: lastError,
  });
}

async function checkLambda(
  functionName: string,
  region: string,
  expectedCodeSha256: string,
): Promise<void> {
  await boundedRetry(async () => {
    const result = await executeFile(
      'aws',
      [
        'lambda',
        'get-function-configuration',
        '--function-name',
        functionName,
        '--region',
        region,
        '--query',
        '[State,LastUpdateStatus,CodeSha256]',
        '--output',
        'json',
      ],
      { timeout: 20_000, maxBuffer: 1_048_576 },
    );
    const state = z
      .tuple([z.string(), z.string(), z.string()])
      .parse(JSON.parse(result.stdout) as unknown);
    if (
      state[0] !== 'Active' ||
      state[1] !== 'Successful' ||
      state[2] !== expectedCodeSha256
    ) {
      throw new Error('Lambda update or code digest is not current');
    }
  }, `Lambda ${functionName}`);
}

async function fetchBoundedBody(
  url: string,
  expectedStatus: number,
  init?: RequestInit,
): Promise<Buffer> {
  let result: Buffer | undefined;
  await boundedRetry(
    async () => {
      const response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== expectedStatus) {
        await response.body?.cancel();
        throw new Error(`Unexpected HTTP status ${response.status}`);
      }
      const reader = response.body?.getReader();
      let bodyBytes = 0;
      const chunks: Uint8Array[] = [];
      if (reader !== undefined) {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          bodyBytes += chunk.value.byteLength;
          if (bodyBytes > 2 * 1_024 * 1_024) {
            await reader.cancel();
            throw new Error('Smoke-test HTTP response exceeded two megabytes');
          }
          chunks.push(chunk.value);
        }
      }
      result = Buffer.concat(chunks);
    },
    `HTTP endpoint ${new URL(url).origin}`,
  );
  if (result === undefined) {
    throw new Error('Smoke-test HTTP request produced no result');
  }
  return result;
}

async function invalidateReviewConsole(distributionId: string): Promise<void> {
  const created = await executeFile(
    'aws',
    [
      'cloudfront',
      'create-invalidation',
      '--distribution-id',
      distributionId,
      '--paths',
      '/*',
      '--query',
      'Invalidation.Id',
      '--output',
      'text',
    ],
    { timeout: 30_000, maxBuffer: 1_048_576 },
  );
  const invalidationId = created.stdout.trim();
  if (!/^[A-Z0-9]{2,128}$/.test(invalidationId)) {
    throw new Error('CloudFront returned an invalid invalidation ID');
  }
  await executeFile(
    'aws',
    [
      'cloudfront',
      'wait',
      'invalidation-completed',
      '--distribution-id',
      distributionId,
      '--id',
      invalidationId,
    ],
    { timeout: 600_000, maxBuffer: 1_048_576 },
  );
}

export function verifyReviewRuntimeConfiguration(
  rawBody: Buffer,
  reviewConsoleUrl: string,
): void {
  const prefix = 'window.__INCIDENT_REVIEW_CONFIG__ = ';
  const body = rawBody.toString('utf8').trim();
  if (!body.startsWith(prefix) || !body.endsWith(';')) {
    throw new Error('Review runtime configuration has an invalid wrapper');
  }

  let rawConfiguration: unknown;
  try {
    rawConfiguration = JSON.parse(body.slice(prefix.length, -1));
  } catch (error) {
    throw new Error('Review runtime configuration is not valid JSON', {
      cause: error,
    });
  }
  const configuration =
    reviewRuntimeConfigurationSchema.parse(rawConfiguration);
  const expectedBaseUrl = new URL(reviewConsoleUrl).origin;
  if (
    configuration.apiBaseUrl !== expectedBaseUrl ||
    configuration.redirectUri !== `${expectedBaseUrl}/`
  ) {
    throw new Error(
      'Review runtime configuration does not use the CloudFront origin',
    );
  }
}

export async function smokeAwsDeployment(
  rawOutputs: unknown,
  region: string,
  lambdaArtifactSha256: string,
  reviewArtifacts: Readonly<Record<string, string>>,
): Promise<{ readonly reviewConsoleUrl: string }> {
  const outputs = terraformOutputSchema.parse(rawOutputs);
  if (!/^[0-9a-f]{64}$/.test(lambdaArtifactSha256)) {
    throw new Error('Lambda release digest is invalid');
  }
  const expectedReviewArtifactNames = ['app.js', 'index.html', 'styles.css'];
  if (
    JSON.stringify(Object.keys(reviewArtifacts).sort()) !==
      JSON.stringify(expectedReviewArtifactNames) ||
    Object.values(reviewArtifacts).some(
      (digest) => !/^[0-9a-f]{64}$/.test(digest),
    )
  ) {
    throw new Error('Review application release digests are invalid');
  }
  const expectedLambdaCodeSha256 = Buffer.from(
    lambdaArtifactSha256,
    'hex',
  ).toString('base64');
  await Promise.all(
    lambdaOutputNames.map((name) =>
      checkLambda(
        requiredStringOutput(outputs, name),
        region,
        expectedLambdaCodeSha256,
      ),
    ),
  );

  await invalidateReviewConsole(
    requiredStringOutput(outputs, 'review_distribution_id'),
  );

  const slackEventsUrl = requiredStringOutput(outputs, 'slack_events_url');
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  await fetchBoundedBody(slackEventsUrl, 401, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': `v0=${'0'.repeat(64)}`,
    },
    body: JSON.stringify({ type: 'url_verification', challenge: 'smoke' }),
  });
  await fetchBoundedBody(
    `${requiredStringOutput(outputs, 'review_api_url')}/incidents`,
    401,
  );
  const reviewConsoleUrl = requiredStringOutput(outputs, 'review_console_url');
  await fetchBoundedBody(reviewConsoleUrl, 200);
  await Promise.all(
    expectedReviewArtifactNames.map(async (filename) => {
      const deployedArtifact = await fetchBoundedBody(
        new URL(`/${filename}`, reviewConsoleUrl).toString(),
        200,
      );
      const deployedDigest = createHash('sha256')
        .update(deployedArtifact)
        .digest('hex');
      if (deployedDigest !== reviewArtifacts[filename]) {
        throw new Error(`Review artifact digest does not match: ${filename}`);
      }
    }),
  );
  const runtimeConfiguration = await fetchBoundedBody(
    new URL('/runtime-config.js', reviewConsoleUrl).toString(),
    200,
  );
  verifyReviewRuntimeConfiguration(runtimeConfiguration, reviewConsoleUrl);
  return { reviewConsoleUrl };
}
