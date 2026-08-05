import { describe, expect, it } from 'vitest';
import { verifyReviewRuntimeConfiguration } from '../../src/deployment/smoke-deployment.js';

const reviewConsoleUrl = 'https://review.example.test';

function runtimeConfiguration(overrides: Record<string, string> = {}): Buffer {
  return Buffer.from(
    `window.__INCIDENT_REVIEW_CONFIG__ = ${JSON.stringify({
      apiBaseUrl: reviewConsoleUrl,
      cognitoBaseUrl: 'https://review.auth.example.test',
      cognitoClientId: 'client-id',
      redirectUri: `${reviewConsoleUrl}/`,
      ...overrides,
    })};`,
  );
}

describe('AWS deployment smoke verification', () => {
  it('accepts a runtime configuration bound to the CloudFront origin', () => {
    expect(() =>
      verifyReviewRuntimeConfiguration(
        runtimeConfiguration(),
        reviewConsoleUrl,
      ),
    ).not.toThrow();
  });

  it('rejects a stale direct API Gateway base URL', () => {
    expect(() =>
      verifyReviewRuntimeConfiguration(
        runtimeConfiguration({
          apiBaseUrl: 'https://api-id.execute-api.ap-southeast-2.amazonaws.com',
        }),
        reviewConsoleUrl,
      ),
    ).toThrow('does not use the CloudFront origin');
  });

  it('rejects malformed executable configuration', () => {
    expect(() =>
      verifyReviewRuntimeConfiguration(
        Buffer.from('window.__INCIDENT_REVIEW_CONFIG__ = alert(1);'),
        reviewConsoleUrl,
      ),
    ).toThrow('not valid JSON');
  });
});
