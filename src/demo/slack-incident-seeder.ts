import { z } from 'zod';
import {
  actorDisplayNames,
  compromisedWafScenario,
  demoChannels,
  formatDemoMessage,
  type DemoActor,
  type DemoChannel,
} from './slack-cybersecurity-scenario.js';

const slackIdSchema = z.string().regex(/^[A-Z][A-Z0-9]{1,63}$/);
const slackUserIdSchema = z.string().regex(/^U[A-Z0-9]{1,63}$/);
const slackTimestampSchema = z.string().regex(/^\d{1,20}\.\d{1,20}$/);
const channelSuffixSchema = z
  .string()
  .max(40)
  .regex(/^[a-z0-9_-]*$/);

const authResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      team_id: slackIdSchema,
      user_id: slackIdSchema,
      user: z.string().min(1).max(200),
      url: z.url(),
    })
    .passthrough(),
  z.object({ ok: z.literal(false), error: z.string().min(1) }).passthrough(),
]);

const createChannelResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      channel: z.object({ id: slackIdSchema, name: z.string().min(1) }),
    })
    .passthrough(),
  z.object({ ok: z.literal(false), error: z.string().min(1) }).passthrough(),
]);

const inviteResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).passthrough(),
  z.object({ ok: z.literal(false), error: z.string().min(1) }).passthrough(),
]);

const postMessageResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      channel: slackIdSchema,
      ts: slackTimestampSchema,
    })
    .passthrough(),
  z.object({ ok: z.literal(false), error: z.string().min(1) }).passthrough(),
]);

type SlackAuth = z.infer<typeof authResponseSchema> & { readonly ok: true };

export interface SlackIncidentSeedConfig {
  readonly workspaceId: string;
  readonly mayaToken: string;
  readonly arjunToken: string;
  readonly channelSuffix?: string;
  readonly delayMs?: number;
  readonly onRecordBotUserId?: string;
}

export interface SeededChannel {
  readonly id: string;
  readonly name: string;
}

export interface SeededAnchor {
  readonly id: string;
  readonly channel: string;
  readonly permalink: string;
}

export interface SlackIncidentSeedResult {
  readonly workspaceId: string;
  readonly actors: Readonly<
    Record<DemoActor, { userId: string; user: string }>
  >;
  readonly channels: Readonly<Record<DemoChannel, SeededChannel>>;
  readonly anchors: readonly SeededAnchor[];
  readonly messageCount: number;
}

export interface SlackIncidentSeederOptions {
  readonly request?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly onProgress?: (message: string) => void;
}

class SlackApiError extends Error {
  public constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}`);
  }
}

export async function seedSlackIncident(
  config: SlackIncidentSeedConfig,
  options: SlackIncidentSeederOptions = {},
): Promise<SlackIncidentSeedResult> {
  validateConfig(config);
  const request = options.request ?? globalThis.fetch;
  const sleep = options.sleep ?? wait;
  const delayMs = config.delayMs ?? 1_100;
  const suffix = config.channelSuffix ?? '';
  const progress = options.onProgress ?? (() => undefined);
  const api = new SlackApi(request, sleep);
  const tokens: Readonly<Record<DemoActor, string>> = {
    maya: config.mayaToken,
    arjun: config.arjunToken,
  };

  progress('Validating both Slack user tokens');
  const [mayaAuth, arjunAuth] = await Promise.all([
    api.auth(config.mayaToken),
    api.auth(config.arjunToken),
  ]);
  validateActors(config.workspaceId, mayaAuth, arjunAuth);
  if (
    config.onRecordBotUserId === mayaAuth.user_id ||
    config.onRecordBotUserId === arjunAuth.user_id
  ) {
    throw new Error(
      'The OnRecord bot user ID must not be one of the two actors',
    );
  }

  const channels = {} as Record<DemoChannel, SeededChannel>;
  for (const baseName of demoChannels) {
    const name = channelName(baseName, suffix);
    progress(`Creating #${name}`);
    const channel = await api.createChannel(config.mayaToken, name);
    channels[baseName] = channel;
    await api.inviteUser(config.mayaToken, channel.id, arjunAuth.user_id);
    if (config.onRecordBotUserId !== undefined) {
      await api.inviteUser(
        config.mayaToken,
        channel.id,
        config.onRecordBotUserId,
      );
    }
  }

  const posted = new Map<string, { channelId: string; ts: string }>();
  const anchors: SeededAnchor[] = [];
  for (const [index, message] of compromisedWafScenario.entries()) {
    const channel = channels[message.channel];
    const parent =
      message.replyTo === undefined ? undefined : posted.get(message.replyTo);
    if (message.replyTo !== undefined && parent === undefined) {
      throw new Error(`Missing posted parent ${message.replyTo}`);
    }
    progress(
      `Posting ${index + 1}/${compromisedWafScenario.length} as ${actorDisplayNames[message.actor].split(' — ')[0]} in #${channel.name}`,
    );
    const result = await api.postMessage(
      tokens[message.actor],
      channel.id,
      formatDemoMessage(message),
      parent?.ts,
    );
    posted.set(message.id, { channelId: channel.id, ts: result.ts });
    if (message.anchor === true) {
      anchors.push({
        id: message.id,
        channel: channel.name,
        permalink: slackPermalink(mayaAuth.url, channel.id, result.ts),
      });
    }
    if (index < compromisedWafScenario.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return {
    workspaceId: config.workspaceId,
    actors: {
      maya: { userId: mayaAuth.user_id, user: mayaAuth.user },
      arjun: { userId: arjunAuth.user_id, user: arjunAuth.user },
    },
    channels,
    anchors,
    messageCount: compromisedWafScenario.length,
  };
}

export function previewSlackIncident(channelSuffix = ''): string {
  channelSuffixSchema.parse(channelSuffix);
  const names = demoChannels.map(
    (name) => `#${channelName(name, channelSuffix)}`,
  );
  const anchors = compromisedWafScenario.filter(
    (message) => message.anchor === true,
  );
  return [
    'OnRecord synthetic Slack incident (dry run)',
    '',
    `Channels: ${names.join(', ')}`,
    `Actors: ${Object.values(actorDisplayNames).join('; ')}`,
    `Messages: ${compromisedWafScenario.length}`,
    `Root threads: ${compromisedWafScenario.filter((message) => message.replyTo === undefined).length}`,
    `Anchor threads: ${anchors.length}`,
    '',
    'No Slack API calls were made. Pass --execute to create the scenario.',
  ].join('\n');
}

function validateConfig(config: SlackIncidentSeedConfig): void {
  slackIdSchema.parse(config.workspaceId);
  channelSuffixSchema.parse(config.channelSuffix ?? '');
  if (config.onRecordBotUserId !== undefined) {
    slackUserIdSchema.parse(config.onRecordBotUserId);
  }
  if (
    config.mayaToken.trim().length === 0 ||
    config.arjunToken.trim().length === 0
  ) {
    throw new Error('Both Slack demo user tokens are required');
  }
  if (config.mayaToken === config.arjunToken) {
    throw new Error('The Slack demo actors must use different user tokens');
  }
  const delayMs = config.delayMs ?? 1_100;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new Error('Slack demo delay must be an integer from 0 to 60000');
  }
}

function validateActors(
  workspaceId: string,
  maya: SlackAuth,
  arjun: SlackAuth,
): void {
  if (maya.team_id !== workspaceId || arjun.team_id !== workspaceId) {
    throw new Error(
      `Refusing to seed: both tokens must belong to configured workspace ${workspaceId}`,
    );
  }
  if (maya.user_id === arjun.user_id) {
    throw new Error(
      'Refusing to seed: both tokens resolve to the same Slack user',
    );
  }
}

function channelName(baseName: DemoChannel, suffix: string): string {
  const name = suffix.length === 0 ? baseName : `${baseName}-${suffix}`;
  if (name.length > 80) {
    throw new Error(`Slack channel name is too long: ${name}`);
  }
  return name;
}

function slackPermalink(
  workspaceUrl: string,
  channelId: string,
  ts: string,
): string {
  const base = workspaceUrl.endsWith('/') ? workspaceUrl : `${workspaceUrl}/`;
  return new URL(
    `archives/${channelId}/p${ts.replace('.', '')}`,
    base,
  ).toString();
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

class SlackApi {
  public constructor(
    private readonly request: typeof fetch,
    private readonly sleep: (milliseconds: number) => Promise<void>,
  ) {}

  public async auth(token: string): Promise<SlackAuth> {
    const data = authResponseSchema.parse(
      await this.call(token, 'auth.test', {}),
    );
    if (!data.ok) {
      throw new SlackApiError('auth.test', data.error);
    }
    return data;
  }

  public async createChannel(
    token: string,
    name: string,
  ): Promise<SeededChannel> {
    const data = createChannelResponseSchema.parse(
      await this.call(token, 'conversations.create', {
        name,
        is_private: false,
      }),
    );
    if (!data.ok) {
      if (data.error === 'name_taken') {
        throw new SlackApiError(
          'conversations.create',
          `${data.error}; choose a unique --channel-suffix`,
        );
      }
      throw new SlackApiError('conversations.create', data.error);
    }
    return data.channel;
  }

  public async inviteUser(
    token: string,
    channel: string,
    user: string,
  ): Promise<void> {
    const data = inviteResponseSchema.parse(
      await this.call(token, 'conversations.invite', { channel, users: user }),
    );
    if (!data.ok && data.error !== 'already_in_channel') {
      throw new SlackApiError('conversations.invite', data.error);
    }
  }

  public async postMessage(
    token: string,
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ readonly ts: string }> {
    const data = postMessageResponseSchema.parse(
      await this.call(token, 'chat.postMessage', {
        channel,
        text,
        unfurl_links: false,
        unfurl_media: false,
        ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
      }),
    );
    if (!data.ok) {
      throw new SlackApiError('chat.postMessage', data.error);
    }
    if (data.channel !== channel) {
      throw new Error(
        'Slack returned a different channel after posting a message',
      );
    }
    return { ts: data.ts };
  }

  private async call(
    token: string,
    method: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await this.request(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 429) {
        if (!response.ok) {
          throw new Error(`Slack ${method} returned HTTP ${response.status}`);
        }
        return (await response.json()) as unknown;
      }
      const retryAfter = Number.parseInt(
        response.headers.get('retry-after') ?? '1',
        10,
      );
      if (attempt === 3) {
        throw new SlackApiError(method, 'rate_limited');
      }
      await this.sleep((Number.isFinite(retryAfter) ? retryAfter : 1) * 1_000);
    }
    throw new SlackApiError(method, 'retry_exhausted');
  }
}
