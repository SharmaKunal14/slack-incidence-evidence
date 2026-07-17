import { z } from 'zod';
import {
  SlackThreadRateLimitError,
  SlackThreadSourceError,
  type FetchSlackThreadPageInput,
  type FetchSlackThreadPageResult,
  type SlackThreadSource,
  type SlackThreadSourceMessage,
} from '../../application/ports/slack-thread-source.js';
import type { SlackBotInstallation } from './web-api-incident-status-notifier.js';

const REPLIES_URL = 'https://slack.com/api/conversations.replies';
const PERMALINK_URL = 'https://slack.com/api/chat.getPermalink';
const PAGE_SIZE = 15;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PERMALINK_CONCURRENCY = 3;

const slackTimestampSchema = z.string().regex(/^\d{1,20}\.\d{1,20}$/);
const sourceInputSchema = z
  .object({
    workspaceId: z.string().regex(/^T[A-Z0-9]{1,63}$/),
    channelId: z.string().regex(/^C[A-Z0-9]{1,63}$/),
    threadTs: slackTimestampSchema,
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

const slackMessageSchema = z
  .object({
    type: z.literal('message'),
    ts: slackTimestampSchema,
    text: z.string().max(100_000).default(''),
    user: z
      .string()
      .regex(/^[A-Z][A-Z0-9]{1,63}$/)
      .optional(),
    bot_id: z
      .string()
      .regex(/^B[A-Z0-9]{1,63}$/)
      .optional(),
    subtype: z.string().min(1).max(128).optional(),
    client_msg_id: z.uuid().optional(),
    edited: z.object({ ts: slackTimestampSchema }).passthrough().optional(),
    metadata: z
      .object({ event_type: z.string().min(1).max(128) })
      .passthrough()
      .optional(),
  })
  .passthrough();

const repliesResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      messages: z.array(slackMessageSchema).max(PAGE_SIZE),
      response_metadata: z
        .object({ next_cursor: z.string().max(2048).default('') })
        .passthrough()
        .optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().min(1).max(128),
    })
    .passthrough(),
]);

const permalinkResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      channel: z.string().regex(/^C[A-Z0-9]{1,63}$/),
      permalink: z.url().max(4096),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().min(1).max(128),
    })
    .passthrough(),
]);

const TERMINAL_SLACK_ERRORS = new Set([
  'access_denied',
  'account_inactive',
  'channel_not_found',
  'invalid_auth',
  'invalid_cursor',
  'missing_scope',
  'no_permission',
  'not_allowed_token_type',
  'not_authed',
  'team_access_not_granted',
  'thread_not_found',
  'token_expired',
  'token_revoked',
]);

export interface SlackThreadWebApiSourceOptions {
  readonly request?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Fetches one bounded thread page and stable source permalinks. */
export class SlackThreadWebApiSource implements SlackThreadSource {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(
    private readonly installation: SlackBotInstallation,
    options: SlackThreadWebApiSourceOptions = {},
  ) {
    if (!/^T[A-Z0-9]{1,63}$/.test(installation.workspaceId)) {
      throw new Error('Slack bot workspace ID is invalid');
    }
    if (installation.botToken.length === 0) {
      throw new Error('Slack bot token must not be empty');
    }
    this.request = options.request ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('Slack request timeout must be a positive integer');
    }
  }

  public async fetchPage(
    rawInput: FetchSlackThreadPageInput,
  ): Promise<FetchSlackThreadPageResult> {
    const input = sourceInputSchema.parse(rawInput);
    if (input.workspaceId !== this.installation.workspaceId) {
      throw new SlackThreadSourceError('SLACK_WORKSPACE_MISMATCH', false);
    }

    const url = new URL(REPLIES_URL);
    url.searchParams.set('channel', input.channelId);
    url.searchParams.set('ts', input.threadTs);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('include_all_metadata', 'true');
    if (input.cursor !== undefined) {
      url.searchParams.set('cursor', input.cursor);
    }

    const response = await this.get(url);
    if (response.status === 429) {
      return {
        outcome: 'rate_limited',
        retryAfterSeconds: parseRetryAfter(response.headers),
      };
    }
    const body = await parseResponse(response);
    const parsed = repliesResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new SlackThreadSourceError('SLACK_INVALID_RESPONSE', true);
    }
    if (!parsed.data.ok) {
      throw slackApiError(parsed.data.error);
    }

    const messages = parsed.data.messages.filter(
      (message) => message.metadata?.event_type !== 'incident_copilot_status',
    );
    const withPermalinks = await mapWithConcurrency(
      messages,
      PERMALINK_CONCURRENCY,
      async (message): Promise<SlackThreadSourceMessage> => {
        const authorId = message.user ?? message.bot_id;
        return {
          messageTs: message.ts,
          occurredAt: slackTimestampToDate(message.ts),
          text: message.text,
          permalink: await this.getPermalink(input.channelId, message.ts),
          ...(authorId === undefined ? {} : { authorId }),
          ...(message.edited === undefined
            ? {}
            : { editedTs: message.edited.ts }),
          ...(message.subtype === undefined
            ? {}
            : { subtype: message.subtype }),
          ...(message.client_msg_id === undefined
            ? {}
            : { clientMessageId: message.client_msg_id }),
        };
      },
    );
    const nextCursor = parsed.data.response_metadata?.next_cursor.trim() ?? '';
    return {
      outcome: 'page',
      messages: withPermalinks,
      nextCursor: nextCursor.length === 0 ? null : nextCursor,
    };
  }

  private async getPermalink(
    channelId: string,
    messageTs: string,
  ): Promise<string | null> {
    const url = new URL(PERMALINK_URL);
    url.searchParams.set('channel', channelId);
    url.searchParams.set('message_ts', messageTs);
    const response = await this.get(url);
    if (response.status === 429) {
      throw new SlackThreadRateLimitError(parseRetryAfter(response.headers));
    }
    const parsed = permalinkResponseSchema.safeParse(
      await parseResponse(response),
    );
    if (!parsed.success) {
      throw new SlackThreadSourceError('SLACK_INVALID_RESPONSE', true);
    }
    if (!parsed.data.ok) {
      if (parsed.data.error === 'message_not_found') {
        return null;
      }
      throw slackApiError(parsed.data.error);
    }
    if (parsed.data.channel !== channelId) {
      throw new SlackThreadSourceError('SLACK_RESPONSE_CHANNEL_MISMATCH', true);
    }
    const permalink = new URL(parsed.data.permalink);
    if (
      permalink.protocol !== 'https:' ||
      !(
        permalink.hostname === 'slack.com' ||
        permalink.hostname.endsWith('.slack.com')
      )
    ) {
      throw new SlackThreadSourceError('SLACK_INVALID_PERMALINK', true);
    }
    return permalink.toString();
  }

  private async get(url: URL): Promise<Response> {
    let response: Response;
    try {
      response = await this.request(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.installation.botToken}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new SlackThreadSourceError('SLACK_NETWORK_ERROR', true, {
        cause: error,
      });
    }
    if (!response.ok && response.status !== 429) {
      throw new SlackThreadSourceError(
        'SLACK_HTTP_ERROR',
        response.status >= 500,
      );
    }
    return response;
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  const body = await readBoundedBody(response);
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new SlackThreadSourceError('SLACK_INVALID_JSON', true, {
      cause: error,
    });
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    throw new SlackThreadSourceError('SLACK_RESPONSE_TOO_LARGE', true);
  }
  if (response.body === null) {
    return '';
  }

  // Undici erases the byte-chunk generic from Response.body. Keep it unknown
  // here and validate every chunk before using it as bytes.
  const reader = (response.body as ReadableStream<unknown>).getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new SlackThreadSourceError('SLACK_INVALID_RESPONSE_BODY', true);
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SlackThreadSourceError('SLACK_RESPONSE_TOO_LARGE', true);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function parseRetryAfter(headers: Headers): number {
  const value = headers.get('retry-after');
  if (value === null || !/^\d{1,6}$/.test(value)) {
    return 60;
  }
  return Math.max(1, Number(value));
}

function slackApiError(error: string): SlackThreadSourceError {
  const safeCode = /^[a-z0-9_]{1,48}$/.test(error)
    ? `SLACK_${error.toUpperCase()}`
    : 'SLACK_API_ERROR';
  return new SlackThreadSourceError(
    safeCode,
    !TERMINAL_SLACK_ERRORS.has(error),
  );
}

function slackTimestampToDate(timestamp: string): Date {
  const [secondsText, fractionText] = timestamp.split('.');
  if (secondsText === undefined || fractionText === undefined) {
    throw new SlackThreadSourceError('SLACK_INVALID_TIMESTAMP', false);
  }
  const milliseconds =
    Number(secondsText) * 1_000 +
    Number(fractionText.padEnd(3, '0').slice(0, 3));
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new SlackThreadSourceError('SLACK_INVALID_TIMESTAMP', false);
  }
  return date;
}

async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  mapper: (input: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const results = new Array<Output>(inputs.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const input = inputs[index];
      if (input !== undefined) {
        results[index] = await mapper(input);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, () =>
      worker(),
    ),
  );
  return results;
}
