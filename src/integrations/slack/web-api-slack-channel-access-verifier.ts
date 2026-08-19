import { z } from 'zod';
import type { RuntimeSlackInstallation } from '../../application/ports/slack-installation-credential-resolver.js';
import type {
  SlackChannelAccessResult,
  SlackChannelAccessVerifier,
} from '../../application/ports/slack-channel-access-verifier.js';

const INFO_URL = 'https://slack.com/api/conversations.info';
const MAX_CHANNELS = 5;
const channelIdSchema = z.string().regex(/^C[A-Z0-9]{1,63}$/u);
const responseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      channel: z
        .object({
          id: channelIdSchema,
          name: z.string().trim().min(1).max(200),
          is_channel: z.literal(true),
          is_private: z.boolean().default(false),
          is_ext_shared: z.boolean().default(false),
          is_org_shared: z.boolean().default(false),
          is_member: z.boolean(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().trim().min(1).max(128),
    })
    .passthrough(),
]);

/** Checks only channel metadata; it never reads or returns message content. */
export class SlackWebApiChannelAccessVerifier implements SlackChannelAccessVerifier {
  public constructor(
    private readonly installation: RuntimeSlackInstallation,
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMilliseconds = 1_500,
  ) {}

  public async verify(
    workspaceId: string,
    channelIds: readonly string[],
  ): Promise<readonly SlackChannelAccessResult[]> {
    if (workspaceId !== this.installation.workspaceId) {
      return channelIds.map((channelId) => ({
        channelId,
        accessible: false,
        code: 'WORKSPACE_RECONNECT_REQUIRED',
        retryable: false,
        displayName: null,
      }));
    }
    const parsedIds = z
      .array(channelIdSchema)
      .min(1)
      .max(MAX_CHANNELS)
      .refine((ids) => new Set(ids).size === ids.length)
      .parse(channelIds);
    return Promise.all(parsedIds.map((channelId) => this.verifyOne(channelId)));
  }

  private async verifyOne(
    channelId: string,
  ): Promise<SlackChannelAccessResult> {
    const url = new URL(INFO_URL);
    url.searchParams.set('channel', channelId);
    let response: Response;
    try {
      response = await this.request(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.installation.botToken}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
    } catch {
      return unavailable(channelId, true);
    }
    if (!response.ok) return unavailable(channelId, response.status >= 500);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return unavailable(channelId, true);
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) return unavailable(channelId, true);
    if (!parsed.data.ok) return mapSlackFailure(channelId, parsed.data.error);
    if (parsed.data.channel.id !== channelId)
      return unavailable(channelId, true);
    const channel = parsed.data.channel;
    if (channel.is_private || channel.is_ext_shared || channel.is_org_shared) {
      return {
        channelId,
        accessible: false,
        code: 'UNSUPPORTED_CHANNEL',
        retryable: false,
        displayName: channel.name,
      };
    }
    if (!channel.is_member) {
      return {
        channelId,
        accessible: false,
        code: 'APP_NOT_IN_CHANNEL',
        retryable: false,
        displayName: channel.name,
      };
    }
    return { channelId, accessible: true, displayName: channel.name };
  }
}

function unavailable(
  channelId: string,
  retryable: boolean,
): SlackChannelAccessResult {
  return {
    channelId,
    accessible: false,
    code: 'VERIFICATION_UNAVAILABLE',
    retryable,
    displayName: null,
  };
}

function mapSlackFailure(
  channelId: string,
  code: string,
): SlackChannelAccessResult {
  if (
    [
      'invalid_auth',
      'token_expired',
      'token_revoked',
      'account_inactive',
      'missing_scope',
      'no_permission',
    ].includes(code)
  ) {
    return {
      channelId,
      accessible: false,
      code: 'WORKSPACE_RECONNECT_REQUIRED',
      retryable: false,
      displayName: null,
    };
  }
  if (['channel_not_found', 'not_in_channel'].includes(code)) {
    return {
      channelId,
      accessible: false,
      code:
        code === 'not_in_channel' ? 'APP_NOT_IN_CHANNEL' : 'CHANNEL_NOT_FOUND',
      retryable: false,
      displayName: null,
    };
  }
  return unavailable(channelId, true);
}
