import { z } from 'zod';

const nonEmptyString = z.string().min(1);

const urlVerificationSchema = z
  .object({
    type: z.literal('url_verification'),
    challenge: nonEmptyString,
  })
  .passthrough();

const appMentionCallbackSchema = z
  .object({
    type: z.literal('event_callback'),
    event_id: nonEmptyString,
    team_id: nonEmptyString,
    event: z
      .object({
        type: z.literal('app_mention'),
        user: nonEmptyString,
        text: z.string(),
        ts: nonEmptyString,
        channel: nonEmptyString,
        thread_ts: nonEmptyString.optional(),
      })
      .passthrough(),
  })
  .passthrough();

const otherEventCallbackSchema = z
  .object({
    type: z.literal('event_callback'),
    event_id: nonEmptyString,
    event: z.object({ type: nonEmptyString }).passthrough(),
  })
  .passthrough();

export type ParsedSlackRequest =
  | { readonly kind: 'url_verification'; readonly challenge: string }
  | {
      readonly kind: 'incident_review_requested';
      readonly eventId: string;
      readonly workspaceId: string;
      readonly channelId: string;
      readonly messageTs: string;
      readonly threadTs?: string;
      readonly userId: string;
      readonly requestedTitle: string;
    }
  | { readonly kind: 'ignored'; readonly eventType: string };

export class InvalidSlackPayloadError extends Error {
  public constructor() {
    super('Slack payload does not match a supported envelope');
    this.name = 'InvalidSlackPayloadError';
  }
}

const REVIEW_COMMAND =
  /^(?:generate|create)\s+(?:(?:incident|post-incident)\s+)?(?:review|rca|postmortem)\b(?:\s*[:-]\s*|\s+)?(?<title>.*)$/i;

export function parseSlackRequest(payload: unknown): ParsedSlackRequest {
  const verification = urlVerificationSchema.safeParse(payload);
  if (verification.success) {
    return { kind: 'url_verification', challenge: verification.data.challenge };
  }

  const mention = appMentionCallbackSchema.safeParse(payload);
  if (mention.success) {
    // Slack public conversation IDs use the C prefix. G (private/MPIM) and D
    // (direct message) are excluded in the first release. This is a fail-closed
    // boundary; a future installation policy will additionally query Slack's
    // conversation metadata rather than relying on identifier type alone.
    if (!mention.data.event.channel.startsWith('C')) {
      return { kind: 'ignored', eventType: 'unsupported_conversation_type' };
    }

    const textWithoutMention = mention.data.event.text
      .replace(/^\s*<@[A-Z0-9]+>\s*/i, '')
      .trim();
    const command = REVIEW_COMMAND.exec(textWithoutMention);
    if (command === null) {
      return {
        kind: 'ignored',
        eventType: 'app_mention_without_review_command',
      };
    }

    const requestedTitle = command.groups?.title?.trim();
    return {
      kind: 'incident_review_requested',
      eventId: mention.data.event_id,
      workspaceId: mention.data.team_id,
      channelId: mention.data.event.channel,
      messageTs: mention.data.event.ts,
      ...(mention.data.event.thread_ts === undefined
        ? {}
        : { threadTs: mention.data.event.thread_ts }),
      userId: mention.data.event.user,
      requestedTitle:
        requestedTitle === undefined || requestedTitle.length === 0
          ? `Incident review requested at ${mention.data.event.ts}`
          : requestedTitle.slice(0, 160),
    };
  }

  const otherEvent = otherEventCallbackSchema.safeParse(payload);
  if (otherEvent.success) {
    return { kind: 'ignored', eventType: otherEvent.data.event.type };
  }

  throw new InvalidSlackPayloadError();
}
