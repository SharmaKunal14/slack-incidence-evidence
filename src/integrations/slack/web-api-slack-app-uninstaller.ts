import { z } from 'zod';
import {
  SlackAppUninstallError,
  type SlackAppUninstallOutcome,
  type SlackAppUninstaller,
} from '../../application/ports/slack-app-uninstaller.js';

const APPS_UNINSTALL_URL = 'https://slack.com/api/apps.uninstall';
const MAX_RESPONSE_BYTES = 64 * 1024;
const providerValueSchema = z
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

/** Bounded adapter for removing one complete Slack app installation. */
export class WebApiSlackAppUninstaller implements SlackAppUninstaller {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(
    configuration: {
      readonly clientId: string;
      readonly clientSecret: string;
    },
    options: {
      readonly request?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {
    this.clientId = providerValueSchema.max(256).parse(configuration.clientId);
    this.clientSecret = providerValueSchema
      .max(256)
      .parse(configuration.clientSecret);
    this.request = options.request ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('Slack app uninstall timeout must be a positive integer');
    }
  }

  public async uninstall(
    rawAccessToken: string,
  ): Promise<SlackAppUninstallOutcome> {
    const accessToken = providerValueSchema.parse(rawAccessToken);
    let response: Response;
    try {
      response = await this.request(APPS_UNINSTALL_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SlackAppUninstallError(true);
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new SlackAppUninstallError(true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SlackAppUninstallError(response.status >= 500);
    }
    const parsed = responseSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) {
      throw new SlackAppUninstallError(false);
    }
    if (parsed.data.ok) {
      return 'UNINSTALLED';
    }
    if (['account_inactive', 'token_revoked'].includes(parsed.data.error)) {
      return 'ALREADY_UNINSTALLED';
    }
    throw new SlackAppUninstallError(
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
    throw new SlackAppUninstallError(false);
  }
  if (response.body === null) {
    throw new SlackAppUninstallError(false);
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
        throw new SlackAppUninstallError(false);
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
    throw new SlackAppUninstallError(false);
  }
}
