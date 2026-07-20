import { z } from 'zod';
import type { RequestScopedIncidentReviewCommand } from '../../application/request-incident-review.js';

export const INCIDENT_SCOPE_CALLBACK_ID = 'incident_scope_v1';
export const INCIDENT_SCOPE_SHORTCUT_CALLBACK_ID = 'scope_incident';

const slackId = z.string().regex(/^[A-Z][A-Z0-9]{1,63}$/);
const channelId = z.string().regex(/^C[A-Z0-9]{1,63}$/);
const userId = z.string().regex(/^U[A-Z0-9]{1,63}$/);
const timestamp = z.string().regex(/^\d{1,20}\.\d{1,20}$/);

const messageShortcutSchema = z
  .object({
    type: z.literal('message_action'),
    callback_id: z.literal(INCIDENT_SCOPE_SHORTCUT_CALLBACK_ID),
    trigger_id: z.string().min(1).max(256),
    team: z.object({ id: z.string().regex(/^T[A-Z0-9]{1,63}$/) }).passthrough(),
    user: z.object({ id: userId }).passthrough(),
    channel: z.object({ id: channelId }).passthrough(),
    message: z
      .object({ ts: timestamp, thread_ts: timestamp.optional() })
      .passthrough(),
  })
  .passthrough();

const privateMetadataSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().regex(/^T[A-Z0-9]{1,63}$/),
    userId,
    channelId,
    messageTs: timestamp,
    threadTs: timestamp.optional(),
    evidenceRetentionDays: z.number().int().min(1).max(365),
  })
  .strict();

const stateValueSchema = z
  .object({
    type: z.string().min(1).max(64),
    value: z.string().nullable().optional(),
    selected_conversation: channelId.nullable().optional(),
    selected_conversations: z.array(channelId).max(4).optional(),
    selected_user: userId.nullable().optional(),
    selected_date_time: z
      .number()
      .int()
      .nonnegative()
      .max(4_102_444_800)
      .nullable()
      .optional(),
    selected_options: z
      .array(z.object({ value: z.string().max(64) }).passthrough())
      .max(10)
      .optional(),
  })
  .passthrough();

const viewSubmissionSchema = z
  .object({
    type: z.literal('view_submission'),
    team: z.object({ id: slackId }).passthrough(),
    user: z.object({ id: userId }).passthrough(),
    view: z
      .object({
        id: z.string().min(1).max(256),
        callback_id: z.literal(INCIDENT_SCOPE_CALLBACK_ID),
        private_metadata: z.string().min(1).max(3_000),
        state: z.object({
          values: z.record(z.string(), z.record(z.string(), stateValueSchema)),
        }),
      })
      .passthrough(),
  })
  .passthrough();

export type ParsedSlackInteraction =
  | {
      readonly kind: 'open_incident_scope';
      readonly triggerId: string;
      readonly workspaceId: string;
      readonly userId: string;
      readonly channelId: string;
      readonly messageTs: string;
      readonly threadTs?: string;
    }
  | {
      readonly kind: 'submit_incident_scope';
      readonly command: RequestScopedIncidentReviewCommand;
    }
  | { readonly kind: 'ignored'; readonly interactionType: string };

export interface InteractionValidationError {
  readonly blockId: string;
  readonly message: string;
}

export class InvalidSlackInteractionError extends Error {
  public constructor(
    public readonly fieldErrors: readonly InteractionValidationError[] = [],
  ) {
    super('Slack interaction payload is invalid');
    this.name = 'InvalidSlackInteractionError';
  }
}

export function parseSlackInteraction(
  payload: unknown,
  now: Date,
): ParsedSlackInteraction {
  const shortcut = messageShortcutSchema.safeParse(payload);
  if (shortcut.success) {
    return {
      kind: 'open_incident_scope',
      triggerId: shortcut.data.trigger_id,
      workspaceId: shortcut.data.team.id,
      userId: shortcut.data.user.id,
      channelId: shortcut.data.channel.id,
      messageTs: shortcut.data.message.ts,
      ...(shortcut.data.message.thread_ts === undefined
        ? {}
        : { threadTs: shortcut.data.message.thread_ts }),
    };
  }

  const submission = viewSubmissionSchema.safeParse(payload);
  if (submission.success) {
    return parseSubmission(submission.data, now);
  }

  const interactionType = z
    .object({ type: z.string().min(1).max(64) })
    .passthrough()
    .safeParse(payload);
  if (interactionType.success) {
    return {
      kind: 'ignored',
      interactionType: interactionType.data.type,
    };
  }
  throw new InvalidSlackInteractionError();
}

function parseSubmission(
  submission: z.infer<typeof viewSubmissionSchema>,
  now: Date,
): ParsedSlackInteraction {
  let metadata: z.infer<typeof privateMetadataSchema>;
  try {
    metadata = privateMetadataSchema.parse(
      JSON.parse(submission.view.private_metadata) as unknown,
    );
  } catch {
    throw new InvalidSlackInteractionError();
  }
  if (
    metadata.workspaceId !== submission.team.id ||
    metadata.userId !== submission.user.id
  ) {
    throw new InvalidSlackInteractionError();
  }

  const values = submission.view.state.values;
  const title = textValue(values, 'title', 'value')?.trim() ?? '';
  const primary = textValue(values, 'primary_channel', 'selected_conversation');
  const additional = arrayValue(
    values,
    'additional_channels',
    'selected_conversations',
  );
  const reviewer = textValue(values, 'reviewer', 'selected_user');
  const startedAtSeconds = numberValue(
    values,
    'started_at',
    'selected_date_time',
  );
  const endedAtSeconds = numberValue(values, 'ended_at', 'selected_date_time');
  const retentionAccepted = arrayValue(
    values,
    'retention',
    'selected_options',
  ).includes('accepted');
  const errors: InteractionValidationError[] = [];
  if (title.length === 0 || title.length > 160) {
    errors.push({
      blockId: 'title',
      message: 'Enter an incident title of 160 characters or fewer.',
    });
  }
  if (primary === undefined || !channelId.safeParse(primary).success) {
    errors.push({
      blockId: 'primary_channel',
      message: 'Select one public primary incident channel.',
    });
  }
  if (reviewer === undefined || !userId.safeParse(reviewer).success) {
    errors.push({ blockId: 'reviewer', message: 'Select a reviewer.' });
  }
  if (startedAtSeconds === undefined || endedAtSeconds === undefined) {
    errors.push({
      blockId: 'ended_at',
      message: 'Select a valid start and end time.',
    });
  } else {
    const durationSeconds = endedAtSeconds - startedAtSeconds;
    if (durationSeconds <= 0) {
      errors.push({
        blockId: 'ended_at',
        message: 'End time must be later than start time.',
      });
    } else if (durationSeconds > 7 * 86_400) {
      errors.push({
        blockId: 'ended_at',
        message: 'The evidence window cannot exceed seven days.',
      });
    } else if (endedAtSeconds * 1_000 > now.getTime() + 5 * 60_000) {
      errors.push({
        blockId: 'ended_at',
        message: 'End time cannot be more than five minutes in the future.',
      });
    }
  }
  if (!retentionAccepted) {
    errors.push({
      blockId: 'retention',
      message: 'Acknowledge the evidence-retention notice.',
    });
  }

  const channelIds =
    primary === undefined ? additional : [primary, ...additional];
  if (new Set(channelIds).size !== channelIds.length) {
    errors.push({
      blockId: 'additional_channels',
      message: 'Do not select the primary channel again.',
    });
  }
  const anchors = parseAnchorPermalinks(
    textValue(values, 'anchor_threads', 'value') ?? '',
    new Set(channelIds),
  );
  if ('error' in anchors) {
    errors.push({ blockId: 'anchor_threads', message: anchors.error });
  }
  if (errors.length > 0) {
    throw new InvalidSlackInteractionError(errors);
  }
  if (
    primary === undefined ||
    reviewer === undefined ||
    startedAtSeconds === undefined ||
    endedAtSeconds === undefined ||
    'error' in anchors
  ) {
    throw new InvalidSlackInteractionError();
  }

  return {
    kind: 'submit_incident_scope',
    command: {
      eventId: `slack-view:${submission.view.id}`,
      workspaceId: metadata.workspaceId,
      channelId: metadata.channelId,
      messageTs: metadata.messageTs,
      ...(metadata.threadTs === undefined
        ? {}
        : { threadTs: metadata.threadTs }),
      userId: metadata.userId,
      requestedTitle: title,
      startedAt: new Date(startedAtSeconds * 1_000).toISOString(),
      endedAt: new Date(endedAtSeconds * 1_000).toISOString(),
      reviewerUserId: reviewer,
      evidenceRetentionDays: metadata.evidenceRetentionDays,
      channels: channelIds.map((selectedChannelId, index) => ({
        channelId: selectedChannelId,
        role: index === 0 ? 'PRIMARY' : 'ADDITIONAL',
        anchorThreadTs: anchors.byChannel.get(selectedChannelId) ?? [],
      })),
    },
  };
}

function findState(
  values: z.infer<typeof viewSubmissionSchema>['view']['state']['values'],
  blockId: string,
): z.infer<typeof stateValueSchema> | undefined {
  return Object.values(values[blockId] ?? {})[0];
}

function textValue(
  values: z.infer<typeof viewSubmissionSchema>['view']['state']['values'],
  blockId: string,
  key: 'value' | 'selected_conversation' | 'selected_user',
): string | undefined {
  const value = findState(values, blockId)?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberValue(
  values: z.infer<typeof viewSubmissionSchema>['view']['state']['values'],
  blockId: string,
  key: 'selected_date_time',
): number | undefined {
  const value = findState(values, blockId)?.[key];
  return typeof value === 'number' ? value : undefined;
}

function arrayValue(
  values: z.infer<typeof viewSubmissionSchema>['view']['state']['values'],
  blockId: string,
  key: 'selected_conversations' | 'selected_options',
): string[] {
  const value = findState(values, blockId)?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => (typeof item === 'string' ? item : item.value));
}

function parseAnchorPermalinks(
  raw: string,
  selectedChannelIds: ReadonlySet<string>,
):
  | { readonly byChannel: ReadonlyMap<string, readonly string[]> }
  | { readonly error: string } {
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > 5) {
    return { error: 'Provide at most five Slack thread permalinks.' };
  }
  const byChannel = new Map<string, string[]>();
  for (const line of lines) {
    let url: URL;
    try {
      url = new URL(line);
    } catch {
      return { error: 'Each anchor must be a valid Slack message permalink.' };
    }
    if (
      url.protocol !== 'https:' ||
      !(url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com')) ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return { error: 'Each anchor must be an HTTPS Slack permalink.' };
    }
    const match =
      /^\/archives\/(?<channel>C[A-Z0-9]{1,63})\/p(?<digits>\d{11,40})\/?$/u.exec(
        url.pathname,
      );
    if (match?.groups === undefined) {
      return { error: 'Each anchor must link directly to a Slack message.' };
    }
    const anchorChannel = match.groups['channel'];
    const digits = match.groups['digits'];
    if (
      anchorChannel === undefined ||
      digits === undefined ||
      !selectedChannelIds.has(anchorChannel)
    ) {
      return { error: 'Anchor threads must belong to a selected channel.' };
    }
    const linkedThreadTs = url.searchParams.get('thread_ts');
    const linkedChannelId = url.searchParams.get('cid');
    if (
      (linkedThreadTs !== null &&
        !timestamp.safeParse(linkedThreadTs).success) ||
      (linkedChannelId !== null && linkedChannelId !== anchorChannel)
    ) {
      return { error: 'Anchor thread permalink parameters are invalid.' };
    }
    const threadTs =
      linkedThreadTs ?? `${digits.slice(0, -6)}.${digits.slice(-6)}`;
    const current = byChannel.get(anchorChannel) ?? [];
    if (!current.includes(threadTs)) {
      current.push(threadTs);
      byChannel.set(anchorChannel, current);
    }
  }
  return { byChannel };
}
