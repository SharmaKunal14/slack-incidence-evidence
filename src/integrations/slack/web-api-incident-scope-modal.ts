import { z } from 'zod';
import type {
  IncidentScopeModal,
  OpenIncidentScopeModalInput,
} from '../../application/ports/incident-scope-modal.js';
import { IncidentScopeModalError } from '../../application/ports/incident-scope-modal.js';
import { INCIDENT_SCOPE_CALLBACK_ID } from './interaction-parser.js';
import type { SlackBotInstallation } from './web-api-incident-status-notifier.js';

const VIEWS_OPEN_URL = 'https://slack.com/api/views.open';
const MAX_RESPONSE_BYTES = 256 * 1024;
const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).passthrough(),
  z
    .object({ ok: z.literal(false), error: z.string().min(1).max(128) })
    .passthrough(),
]);

export class SlackWebApiIncidentScopeModal implements IncidentScopeModal {
  private readonly request: typeof fetch;

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
    this.timeoutMs = options.timeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('Slack modal timeout must be a positive integer');
    }
  }

  private readonly timeoutMs: number;

  public async open(input: OpenIncidentScopeModalInput): Promise<void> {
    if (input.workspaceId !== this.installation.workspaceId) {
      throw new IncidentScopeModalError('SLACK_WORKSPACE_MISMATCH', false);
    }
    let response: Response;
    try {
      response = await this.request(VIEWS_OPEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.installation.botToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          trigger_id: input.triggerId,
          view: buildIncidentScopeView(input),
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new IncidentScopeModalError('SLACK_MODAL_NETWORK_ERROR', true, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new IncidentScopeModalError(
        'SLACK_MODAL_HTTP_ERROR',
        response.status >= 500,
      );
    }
    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength !== null &&
      /^\d+$/u.test(declaredLength) &&
      Number(declaredLength) > MAX_RESPONSE_BYTES
    ) {
      throw new IncidentScopeModalError('SLACK_MODAL_RESPONSE_TOO_LARGE', true);
    }
    const body = await readBoundedBody(response);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(body) as unknown;
    } catch (error) {
      throw new IncidentScopeModalError('SLACK_MODAL_INVALID_JSON', true, {
        cause: error,
      });
    }
    const parsed = responseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new IncidentScopeModalError('SLACK_MODAL_INVALID_RESPONSE', true);
    }
    if (!parsed.data.ok) {
      throw new IncidentScopeModalError(
        `SLACK_MODAL_${parsed.data.error.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}`,
        false,
      );
    }
  }
}

async function readBoundedBody(response: Response): Promise<string> {
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
        throw new IncidentScopeModalError(
          'SLACK_MODAL_INVALID_RESPONSE_BODY',
          true,
        );
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new IncidentScopeModalError(
          'SLACK_MODAL_RESPONSE_TOO_LARGE',
          true,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export function buildIncidentScopeView(
  input: OpenIncidentScopeModalInput,
): Readonly<Record<string, unknown>> {
  const metadata = JSON.stringify({
    version: 1,
    workspaceId: input.workspaceId,
    userId: input.userId,
    channelId: input.channelId,
    messageTs: input.messageTs,
    ...(input.threadTs === undefined ? {} : { threadTs: input.threadTs }),
    evidenceRetentionDays: input.evidenceRetentionDays,
  });
  return {
    type: 'modal',
    callback_id: INCIDENT_SCOPE_CALLBACK_ID,
    private_metadata: metadata,
    title: { type: 'plain_text', text: 'Scope incident' },
    submit: { type: 'plain_text', text: 'Collect evidence' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      inputBlock('title', 'incident_title', 'Incident title', {
        type: 'plain_text_input',
        action_id: 'incident_title',
        max_length: 160,
        focus_on_load: true,
      }),
      inputBlock('started_at', 'incident_started_at', 'Start time', {
        type: 'datetimepicker',
        action_id: 'incident_started_at',
        initial_date_time: Math.floor(input.defaultStartedAt.getTime() / 1_000),
      }),
      inputBlock('ended_at', 'incident_ended_at', 'End time', {
        type: 'datetimepicker',
        action_id: 'incident_ended_at',
        initial_date_time: Math.floor(input.defaultEndedAt.getTime() / 1_000),
      }),
      inputBlock(
        'primary_channel',
        'primary_channel',
        'Primary incident channel',
        {
          type: 'conversations_select',
          action_id: 'primary_channel',
          initial_conversation: input.channelId,
          filter: {
            include: ['public'],
            exclude_external_shared_channels: true,
          },
        },
      ),
      inputBlock(
        'additional_channels',
        'additional_channels',
        'Additional public channels',
        {
          type: 'multi_conversations_select',
          action_id: 'additional_channels',
          max_selected_items: 4,
          filter: {
            include: ['public'],
            exclude_external_shared_channels: true,
          },
        },
        true,
      ),
      inputBlock(
        'anchor_threads',
        'anchor_threads',
        'Additional thread permalinks',
        {
          type: 'plain_text_input',
          action_id: 'anchor_threads',
          multiline: true,
          max_length: 3_000,
          placeholder: {
            type: 'plain_text',
            text: 'Optional: roots outside the selected window, one per line (maximum five)',
          },
        },
        true,
      ),
      ...reviewerBlocks(input),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Evidence retention*\nCollected message snapshots receive a ${input.evidenceRetentionDays}-day retention deadline. This release records the deadline; operators must configure the documented deletion process before production use. Access restrictions and unavailable periods remain visible in the coverage manifest.`,
        },
      },
      inputBlock('retention', 'retention', 'Retention acknowledgement', {
        type: 'checkboxes',
        action_id: 'retention',
        options: [
          {
            text: {
              type: 'plain_text',
              text: 'I understand the retention policy and current deletion limitation.',
            },
            value: 'accepted',
          },
        ],
      }),
    ],
  };
}

function reviewerBlocks(
  input: OpenIncidentScopeModalInput,
): readonly Readonly<Record<string, unknown>>[] {
  if (input.eligibleReviewers === undefined) {
    return [];
  }
  if (input.eligibleReviewers.length === 0) {
    return [];
  }
  const options = input.eligibleReviewers.map(({ slackUserId }) => ({
    text: { type: 'plain_text', text: slackUserId },
    value: slackUserId,
  }));
  return [
    inputBlock(
      'reviewer',
      'reviewer',
      'Initial reviewer',
      {
        type: 'static_select',
        action_id: 'reviewer',
        options,
        placeholder: {
          type: 'plain_text',
          text: 'Optional — assign later in OnRecord',
        },
      },
      true,
    ),
  ];
}

function inputBlock(
  blockId: string,
  actionId: string,
  label: string,
  element: Readonly<Record<string, unknown>>,
  optional = false,
): Readonly<Record<string, unknown>> {
  return {
    type: 'input',
    block_id: blockId,
    optional,
    label: { type: 'plain_text', text: label },
    element: { ...element, action_id: actionId },
  };
}
