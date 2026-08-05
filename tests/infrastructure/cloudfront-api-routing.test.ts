import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function terraformFile(name: string): Promise<string> {
  return readFile(resolve('infrastructure/terraform', name), 'utf8');
}

describe('CloudFront browser API routing', () => {
  it('keeps authenticated browser traffic and onboarding cookies same-origin', async () => {
    const [review, onboarding, outputs] = await Promise.all([
      terraformFile('review.tf'),
      terraformFile('onboarding.tf'),
      terraformFile('outputs.tf'),
    ]);

    expect(review).toContain('name = "Managed-AllViewerExceptHostHeader"');
    expect(review).toContain('origin_id   = "application-api"');
    expect(review).toContain('path_pattern               = "review/*"');
    expect(review).toContain('path_pattern               = "onboarding/*"');
    expect(review).toContain(
      'origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host_header.id',
    );
    expect(review).toContain('apiBaseUrl      = local.review_application_url');
    expect(review).toContain(
      'source_hash   = sha256(local.review_runtime_configuration)',
    );
    expect(onboarding).toContain(
      'slack_oauth_redirect_uri = "${local.review_application_url}/onboarding/slack/callback"',
    );
    expect(outputs).toContain(
      'value       = "${local.review_application_url}/onboarding/slack/start"',
    );
  });

  it('does not cache API responses or mask API errors with the SPA document', async () => {
    const review = await terraformFile('review.tf');

    expect(
      review.match(/target_origin_id\s+= "application-api"/gu),
    ).toHaveLength(2);
    expect(
      review.match(
        /cache_policy_id\s+= data\.aws_cloudfront_cache_policy\.caching_disabled\.id/gu,
      ),
    ).toHaveLength(3);
    expect(review).not.toContain('custom_error_response');
  });

  it('does not expose a redundant cross-origin browser API', async () => {
    const api = await terraformFile('main.tf');
    const review = await terraformFile('review.tf');

    expect(api).not.toContain('cors_configuration');
    expect(review).not.toContain('https://*.execute-api.');
  });
});
