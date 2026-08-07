import { z } from 'zod';
import {
  SlackTokenRevocationError,
  type SlackTokenRevocationOutcome,
  type SlackTokenRevoker,
} from '../../application/ports/slack-token-revoker.js';

const AUTH_REVOKE_URL = 'https://slack.com/api/auth.revoke';
const MAX_RESPONSE_BYTES = 64 * 1024;
const accessTokenSchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[\x21-\x7e]+$/u);
const responseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().trim().min(1).max(128),
    })
    .passthrough(),
]);

/** Bounded adapter for Slack's token revocation endpoint. */
export class WebApiSlackTokenRevoker implements SlackTokenRevoker {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(
    options: {
      readonly request?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {
    this.request = options.request ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('Slack revocation timeout must be a positive integer');
    }
  }

  public async revoke(
    rawAccessToken: string,
  ): Promise<SlackTokenRevocationOutcome> {
    const accessToken = accessTokenSchema.parse(rawAccessToken);
    let response: Response;
    try {
      response = await this.request(AUTH_REVOKE_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: new URLSearchParams(),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SlackTokenRevocationError(true);
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new SlackTokenRevocationError(true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SlackTokenRevocationError(response.status >= 500);
    }
    const parsed = responseSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) {
      throw new SlackTokenRevocationError(false);
    }
    if (parsed.data.ok) {
      return 'REVOKED';
    }
    if (
      ['account_inactive', 'invalid_auth', 'token_revoked'].includes(
        parsed.data.error,
      )
    ) {
      return 'ALREADY_REVOKED';
    }
    throw new SlackTokenRevocationError(
      [
        'fatal_error',
        'internal_error',
        'request_timeout',
        'service_unavailable',
      ].includes(parsed.data.error),
    );
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    throw new SlackTokenRevocationError(false);
  }
  if (response.body === null) {
    throw new SlackTokenRevocationError(false);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SlackTokenRevocationError(false);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'),
    ) as unknown;
  } catch {
    throw new SlackTokenRevocationError(false);
  }
}
