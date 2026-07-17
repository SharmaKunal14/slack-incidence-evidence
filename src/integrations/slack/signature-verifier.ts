import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SlackSignatureInput {
  readonly rawBody: Buffer;
  readonly signature: string | undefined;
  readonly timestamp: string | undefined;
  readonly now: Date;
}

export type SlackSignatureVerification =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason:
        | 'missing_headers'
        | 'invalid_timestamp'
        | 'stale_request'
        | 'signature_mismatch';
    };

const SLACK_SIGNATURE_VERSION = 'v0';
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export class SlackSignatureVerifier {
  public constructor(
    private readonly signingSecret: string,
    private readonly toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  ) {
    if (signingSecret.length === 0) {
      throw new Error('Slack signing secret must not be empty');
    }
  }

  public verify(input: SlackSignatureInput): SlackSignatureVerification {
    if (input.signature === undefined || input.timestamp === undefined) {
      return { valid: false, reason: 'missing_headers' };
    }

    if (!/^\d+$/.test(input.timestamp)) {
      return { valid: false, reason: 'invalid_timestamp' };
    }

    const timestampSeconds = Number(input.timestamp);
    if (!Number.isSafeInteger(timestampSeconds)) {
      return { valid: false, reason: 'invalid_timestamp' };
    }

    const ageSeconds = Math.abs(input.now.getTime() / 1000 - timestampSeconds);
    if (ageSeconds > this.toleranceSeconds) {
      return { valid: false, reason: 'stale_request' };
    }

    const baseString = `${SLACK_SIGNATURE_VERSION}:${input.timestamp}:${input.rawBody.toString('utf8')}`;
    const expected = `${SLACK_SIGNATURE_VERSION}=${createHmac(
      'sha256',
      this.signingSecret,
    )
      .update(baseString, 'utf8')
      .digest('hex')}`;

    const expectedBytes = Buffer.from(expected, 'utf8');
    const providedBytes = Buffer.from(input.signature, 'utf8');
    if (
      expectedBytes.length !== providedBytes.length ||
      !timingSafeEqual(expectedBytes, providedBytes)
    ) {
      return { valid: false, reason: 'signature_mismatch' };
    }

    return { valid: true };
  }
}
