import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SlackSignatureVerifier } from '../../../src/integrations/slack/signature-verifier.js';

const secret = 'development-signing-secret';
const now = new Date('2026-07-17T01:00:00.000Z');
const timestamp = String(now.getTime() / 1000);
const body = Buffer.from('{"type":"event_callback"}', 'utf8');

function sign(rawBody: Buffer, requestTimestamp = timestamp): string {
  return `v0=${createHmac('sha256', secret)
    .update(`v0:${requestTimestamp}:${rawBody.toString('utf8')}`)
    .digest('hex')}`;
}

describe('SlackSignatureVerifier', () => {
  const verifier = new SlackSignatureVerifier(secret);

  it('accepts an authentic, recent request', () => {
    expect(
      verifier.verify({
        rawBody: body,
        signature: sign(body),
        timestamp,
        now,
      }),
    ).toEqual({ valid: true });
  });

  it('rejects a modified body', () => {
    const modified = Buffer.from('{"type":"url_verification"}', 'utf8');
    expect(
      verifier.verify({
        rawBody: modified,
        signature: sign(body),
        timestamp,
        now,
      }),
    ).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('rejects an authentic request outside the replay window', () => {
    const staleTimestamp = String(
      timestamp === '0' ? 0 : Number(timestamp) - 301,
    );
    expect(
      verifier.verify({
        rawBody: body,
        signature: sign(body, staleTimestamp),
        timestamp: staleTimestamp,
        now,
      }),
    ).toEqual({ valid: false, reason: 'stale_request' });
  });
});
