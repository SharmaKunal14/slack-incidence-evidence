import { z } from 'zod';
import {
  SlackChannelSourceError,
  type FetchSlackChannelPageInput,
  type FetchSlackChannelPageResult,
  type SlackChannelSource,
  type SlackChannelSourceMessage,
} from '../../application/ports/slack-channel-source.js';
import type { SlackBotInstallation } from './web-api-incident-status-notifier.js';

const HISTORY_URL = 'https://slack.com/api/conversations.history';
const REPLIES_URL = 'https://slack.com/api/conversations.replies';
const INFO_URL = 'https://slack.com/api/conversations.info';
const PERMALINK_URL = 'https://slack.com/api/chat.getPermalink';
const PAGE_SIZE = 15;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const timestampSchema = z.string().regex(/^\d{1,20}\.\d{1,20}$/);

const messageSchema = z
  .object({
    type: z.literal('message'),
    ts: timestampSchema,
    text: z.string().max(100_000).default(''),
    reply_count: z.number().int().nonnegative().max(1_000_000).optional(),
    thread_ts: timestampSchema.optional(),
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
    edited: z.object({ ts: timestampSchema }).passthrough().optional(),
    metadata: z
      .object({ event_type: z.string().min(1).max(128) })
      .passthrough()
      .optional(),
  })
  .passthrough();

const pageResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      messages: z.array(messageSchema).max(PAGE_SIZE + 1),
      has_more: z.boolean().default(false),
      response_metadata: z
        .object({ next_cursor: z.string().max(2048).default('') })
        .passthrough()
        .optional(),
    })
    .passthrough(),
  z
    .object({ ok: z.literal(false), error: z.string().min(1).max(128) })
    .passthrough(),
]);

const infoResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      channel: z
        .object({
          id: z.string().regex(/^C[A-Z0-9]{1,63}$/),
          name: z.string().min(1).max(200),
          is_channel: z.literal(true),
          is_private: z.boolean(),
          is_member: z.boolean(),
          is_ext_shared: z.boolean().default(false),
          is_org_shared: z.boolean().default(false),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({ ok: z.literal(false), error: z.string().min(1).max(128) })
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
    .object({ ok: z.literal(false), error: z.string().min(1).max(128) })
    .passthrough(),
]);

class RateLimited extends Error {
  public constructor(readonly retryAfterSeconds: number) {
    super('Slack request was rate limited');
  }
}

export class SlackChannelWebApiSource implements SlackChannelSource {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(
    private readonly installation: SlackBotInstallation,
    options: {
      readonly request?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {
    if (!/^T[A-Z0-9]{1,63}$/u.test(installation.workspaceId)) {
      throw new Error('Slack bot workspace ID is invalid');
    }
    if (installation.botToken.length === 0) {
      throw new Error('Slack bot token must not be empty');
    }
    this.request = options.request ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  public async fetchPage(
    input: FetchSlackChannelPageInput,
  ): Promise<FetchSlackChannelPageResult> {
    validateInput(input, this.installation.workspaceId);
    try {
      const displayName = input.includeDisplayName
        ? await this.requireReadablePublicChannel(input.channelId)
        : undefined;
      const pageUrl = new URL(
        input.phase === 'CHANNEL' ? HISTORY_URL : REPLIES_URL,
      );
      pageUrl.searchParams.set('channel', input.channelId);
      pageUrl.searchParams.set('oldest', toSlackTimestamp(input.oldest));
      pageUrl.searchParams.set('latest', toSlackTimestamp(input.latest));
      pageUrl.searchParams.set('inclusive', 'true');
      pageUrl.searchParams.set('limit', String(PAGE_SIZE));
      pageUrl.searchParams.set('include_all_metadata', 'true');
      if (input.threadTs !== undefined) {
        pageUrl.searchParams.set('ts', input.threadTs);
      }
      if (input.cursor !== undefined) {
        pageUrl.searchParams.set('cursor', input.cursor);
      }
      const response = await this.get(pageUrl);
      const parsed = pageResponseSchema.safeParse(
        await parseResponse(response),
      );
      if (!parsed.success) {
        throw new SlackChannelSourceError('SLACK_INVALID_RESPONSE', true);
      }
      if (!parsed.data.ok) {
        throw slackApiError(parsed.data.error);
      }
      const messages = parsed.data.messages.filter((message) => {
        const occurredAt = slackTimestampToDate(message.ts);
        return (
          message.metadata?.event_type !== 'incident_copilot_status' &&
          occurredAt.getTime() >= input.oldest.getTime() &&
          occurredAt.getTime() <= input.latest.getTime()
        );
      });
      const withPermalinks = await mapWithConcurrency(
        messages,
        3,
        async (message): Promise<SlackChannelSourceMessage> => {
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
      const nextCursor =
        parsed.data.response_metadata?.next_cursor.trim() ?? '';
      if (parsed.data.has_more && nextCursor.length === 0) {
        throw new SlackChannelSourceError('SLACK_CURSOR_MISSING', true);
      }
      return {
        outcome: 'page',
        messages: withPermalinks,
        threadRootTimestamps:
          input.phase === 'CHANNEL'
            ? messages
                .filter(
                  (message) =>
                    (message.reply_count ?? 0) > 0 &&
                    (message.thread_ts === undefined ||
                      message.thread_ts === message.ts),
                )
                .map((message) => message.ts)
            : [],
        nextCursor: nextCursor.length === 0 ? null : nextCursor,
        ...(displayName === undefined ? {} : { displayName }),
      };
    } catch (error) {
      if (error instanceof RateLimited) {
        return {
          outcome: 'rate_limited',
          retryAfterSeconds: error.retryAfterSeconds,
        };
      }
      throw error;
    }
  }

  private async requireReadablePublicChannel(
    channelId: string,
  ): Promise<string> {
    const url = new URL(INFO_URL);
    url.searchParams.set('channel', channelId);
    const parsed = infoResponseSchema.safeParse(
      await parseResponse(await this.get(url)),
    );
    if (!parsed.success) {
      throw new SlackChannelSourceError('SLACK_INVALID_RESPONSE', true);
    }
    if (!parsed.data.ok) {
      throw slackApiError(parsed.data.error);
    }
    const channel = parsed.data.channel;
    if (channel.id !== channelId) {
      throw new SlackChannelSourceError(
        'SLACK_RESPONSE_CHANNEL_MISMATCH',
        true,
      );
    }
    if (
      channel.is_private ||
      channel.is_ext_shared ||
      channel.is_org_shared ||
      !channel.is_member
    ) {
      throw new SlackChannelSourceError(
        'SLACK_CHANNEL_ACCESS_UNAVAILABLE',
        false,
        'INACCESSIBLE',
      );
    }
    return channel.name;
  }

  private async getPermalink(
    channelId: string,
    messageTs: string,
  ): Promise<string | null> {
    const url = new URL(PERMALINK_URL);
    url.searchParams.set('channel', channelId);
    url.searchParams.set('message_ts', messageTs);
    const parsed = permalinkResponseSchema.safeParse(
      await parseResponse(await this.get(url)),
    );
    if (!parsed.success) {
      throw new SlackChannelSourceError('SLACK_INVALID_RESPONSE', true);
    }
    if (!parsed.data.ok) {
      if (parsed.data.error === 'message_not_found') {
        return null;
      }
      throw slackApiError(parsed.data.error);
    }
    if (parsed.data.channel !== channelId) {
      throw new SlackChannelSourceError(
        'SLACK_RESPONSE_CHANNEL_MISMATCH',
        true,
      );
    }
    const permalink = new URL(parsed.data.permalink);
    if (
      permalink.protocol !== 'https:' ||
      !(
        permalink.hostname === 'slack.com' ||
        permalink.hostname.endsWith('.slack.com')
      )
    ) {
      throw new SlackChannelSourceError('SLACK_INVALID_PERMALINK', true);
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
      throw new SlackChannelSourceError('SLACK_NETWORK_ERROR', true, 'FAILED', {
        cause: error,
      });
    }
    if (response.status === 429) {
      throw new RateLimited(parseRetryAfter(response.headers));
    }
    if (!response.ok) {
      throw new SlackChannelSourceError(
        'SLACK_HTTP_ERROR',
        response.status >= 500,
      );
    }
    return response;
  }
}

function validateInput(
  input: FetchSlackChannelPageInput,
  workspaceId: string,
): void {
  if (input.workspaceId !== workspaceId) {
    throw new SlackChannelSourceError('SLACK_WORKSPACE_MISMATCH', false);
  }
  if (!/^C[A-Z0-9]{1,63}$/u.test(input.channelId)) {
    throw new SlackChannelSourceError('SLACK_CHANNEL_INVALID', false);
  }
  if (input.phase === 'ANCHOR_THREAD' && input.threadTs === undefined) {
    throw new SlackChannelSourceError('SLACK_THREAD_TIMESTAMP_MISSING', false);
  }
  if (input.latest.getTime() <= input.oldest.getTime()) {
    throw new SlackChannelSourceError('SLACK_WINDOW_INVALID', false);
  }
}

function slackApiError(code: string): SlackChannelSourceError {
  if (
    [
      'invalid_auth',
      'token_expired',
      'token_revoked',
      'account_inactive',
    ].includes(code)
  ) {
    return new SlackChannelSourceError(`SLACK_${code}`, false, 'REVOKED');
  }
  if (
    [
      'access_denied',
      'channel_not_found',
      'missing_scope',
      'no_permission',
      'not_in_channel',
      'team_access_not_granted',
    ].includes(code)
  ) {
    return new SlackChannelSourceError(`SLACK_${code}`, false, 'INACCESSIBLE');
  }
  return new SlackChannelSourceError(
    `SLACK_${code}`,
    !['invalid_cursor', 'thread_not_found'].includes(code),
  );
}

async function parseResponse(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    throw new SlackChannelSourceError('SLACK_RESPONSE_TOO_LARGE', true);
  }
  const body = await readBoundedBody(response, MAX_RESPONSE_BYTES);
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new SlackChannelSourceError('SLACK_INVALID_JSON', true, 'FAILED', {
      cause: error,
    });
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (response.body === null) {
    return '';
  }
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
        throw new SlackChannelSourceError('SLACK_INVALID_RESPONSE_BODY', true);
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new SlackChannelSourceError('SLACK_RESPONSE_TOO_LARGE', true);
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
  return value !== null && /^\d{1,6}$/u.test(value)
    ? Math.max(1, Number(value))
    : 60;
}

function toSlackTimestamp(value: Date): string {
  return (value.getTime() / 1_000).toFixed(3);
}

function slackTimestampToDate(value: string): Date {
  const [secondsText, fractionText = '0'] = value.split('.');
  return new Date(
    Number(secondsText) * 1_000 +
      Number(fractionText.slice(0, 3).padEnd(3, '0')),
  );
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        const value = values[index];
        if (value === undefined) {
          return;
        }
        results[index] = await mapper(value);
      }
    }),
  );
  return results;
}
