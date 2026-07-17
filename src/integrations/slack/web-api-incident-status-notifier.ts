import { z } from 'zod';
import type {
  IncidentAcceptedNotification,
  IncidentStatusNotifier,
} from '../../application/ports/incident-status-notifier.js';

const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';
const MAX_RESPONSE_BYTES = 64 * 1024;

const slackTimestampSchema = z.string().regex(/^\d{1,20}\.\d{1,20}$/);
const notificationSchema = z
  .object({
    workspaceId: z.string().regex(/^T[A-Z0-9]{1,63}$/),
    incidentId: z.uuid(),
    channelId: z.string().regex(/^C[A-Z0-9]{1,63}$/),
    threadTs: slackTimestampSchema,
  })
  .strict();

const postMessageResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      channel: z.string().regex(/^C[A-Z0-9]{1,63}$/),
      ts: slackTimestampSchema,
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().min(1).max(128),
    })
    .passthrough(),
]);

export interface SlackBotInstallation {
  readonly workspaceId: string;
  readonly botToken: string;
}

export interface SlackWebApiIncidentStatusNotifierOptions {
  readonly installation: SlackBotInstallation;
  readonly request?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Posts bounded, content-free progress messages to the triggering Slack thread.
 *
 * The incident UUID is also sent as Slack's client_msg_id. It is stable across
 * SQS redelivery, so an ambiguous HTTP timeout can be retried without creating
 * a second logical message. It is an idempotency identifier, not a secret.
 */
export class SlackWebApiIncidentStatusNotifier implements IncidentStatusNotifier {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(
    private readonly installation: SlackBotInstallation,
    options: Omit<
      SlackWebApiIncidentStatusNotifierOptions,
      'installation'
    > = {},
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

  public async notifyAccepted(
    notification: IncidentAcceptedNotification,
  ): Promise<void> {
    const input = notificationSchema.parse(notification);
    if (input.workspaceId !== this.installation.workspaceId) {
      throw new SlackWebApiError('SLACK_WORKSPACE_MISMATCH');
    }

    let response: Response;
    try {
      response = await this.request(SLACK_POST_MESSAGE_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.installation.botToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: input.channelId,
          thread_ts: input.threadTs,
          client_msg_id: input.incidentId,
          text: [
            'Incident review accepted.',
            `Reference: ${input.incidentId}`,
            'Status: collecting evidence.',
          ].join('\n'),
          mrkdwn: false,
          unfurl_links: false,
          unfurl_media: false,
          metadata: {
            event_type: 'incident_copilot_status',
            event_payload: { incident_id: input.incidentId },
          },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new SlackWebApiError('SLACK_NETWORK_ERROR', { cause: error });
    }

    if (response.status === 429) {
      throw new SlackRateLimitError(parseRetryAfter(response.headers));
    }
    if (!response.ok) {
      throw new SlackWebApiError('SLACK_HTTP_ERROR');
    }

    const body = await readBoundedResponse(response);
    const parsed = postMessageResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new SlackWebApiError('SLACK_INVALID_RESPONSE');
    }
    if (!parsed.data.ok) {
      throw new SlackWebApiError(slackErrorCode(parsed.data.error));
    }
    if (parsed.data.channel !== input.channelId) {
      throw new SlackWebApiError('SLACK_RESPONSE_CHANNEL_MISMATCH');
    }
  }
}

export class SlackWebApiError extends Error {
  public constructor(
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super('Slack Web API request failed', options);
    this.name = 'SlackWebApiError';
  }
}

export class SlackRateLimitError extends SlackWebApiError {
  public constructor(public readonly retryAfterSeconds: number | null) {
    super('SLACK_RATE_LIMITED');
    this.name = 'SlackRateLimitError';
  }
}

async function readBoundedResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new SlackWebApiError('SLACK_RESPONSE_TOO_LARGE');
  }

  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new SlackWebApiError('SLACK_INVALID_JSON', { cause: error });
  }
}

function parseRetryAfter(headers: Headers): number | null {
  const value = headers.get('retry-after');
  if (value === null || !/^\d{1,6}$/.test(value)) {
    return null;
  }
  return Number(value);
}

function slackErrorCode(error: string): string {
  if (!/^[a-z0-9_]{1,48}$/.test(error)) {
    return 'SLACK_API_ERROR';
  }
  return `SLACK_${error.toUpperCase()}`;
}
