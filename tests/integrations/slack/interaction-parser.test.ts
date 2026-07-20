import { describe, expect, it } from 'vitest';
import {
  INCIDENT_SCOPE_CALLBACK_ID,
  INCIDENT_SCOPE_SHORTCUT_CALLBACK_ID,
  InvalidSlackInteractionError,
  parseSlackInteraction,
} from '../../../src/integrations/slack/interaction-parser.js';

const now = new Date('2026-07-20T04:00:00.000Z');

function submission(
  overrides: {
    readonly startedAt?: number;
    readonly endedAt?: number;
    readonly additional?: readonly string[];
    readonly anchors?: string;
  } = {},
): unknown {
  return {
    type: 'view_submission',
    team: { id: 'T001' },
    user: { id: 'U001' },
    view: {
      id: 'V001',
      callback_id: INCIDENT_SCOPE_CALLBACK_ID,
      private_metadata: JSON.stringify({
        version: 1,
        workspaceId: 'T001',
        userId: 'U001',
        channelId: 'C001',
        messageTs: '1721178000.000100',
        evidenceRetentionDays: 30,
      }),
      state: {
        values: {
          title: {
            incident_title: {
              type: 'plain_text_input',
              value: 'Checkout outage',
            },
          },
          started_at: {
            incident_started_at: {
              type: 'datetimepicker',
              selected_date_time:
                overrides.startedAt ??
                Date.parse('2026-07-20T02:00:00Z') / 1_000,
            },
          },
          ended_at: {
            incident_ended_at: {
              type: 'datetimepicker',
              selected_date_time:
                overrides.endedAt ?? Date.parse('2026-07-20T03:00:00Z') / 1_000,
            },
          },
          primary_channel: {
            primary_channel: {
              type: 'conversations_select',
              selected_conversation: 'C001',
            },
          },
          additional_channels: {
            additional_channels: {
              type: 'multi_conversations_select',
              selected_conversations: overrides.additional ?? ['C002'],
            },
          },
          anchor_threads: {
            anchor_threads: {
              type: 'plain_text_input',
              value:
                overrides.anchors ??
                'https://acme.slack.com/archives/C002/p1721178000000200?thread_ts=1721177000.000100&cid=C002',
            },
          },
          reviewer: {
            reviewer: { type: 'users_select', selected_user: 'U002' },
          },
          retention: {
            retention: {
              type: 'checkboxes',
              selected_options: [{ value: 'accepted' }],
            },
          },
        },
      },
    },
  };
}

describe('Slack interaction parser', () => {
  it('accepts only the configured public-channel message shortcut', () => {
    expect(
      parseSlackInteraction(
        {
          type: 'message_action',
          callback_id: INCIDENT_SCOPE_SHORTCUT_CALLBACK_ID,
          trigger_id: 'trigger-1',
          team: { id: 'T001' },
          user: { id: 'U001' },
          channel: { id: 'C001' },
          message: { ts: '1721178000.000100' },
        },
        now,
      ),
    ).toEqual({
      kind: 'open_incident_scope',
      triggerId: 'trigger-1',
      workspaceId: 'T001',
      userId: 'U001',
      channelId: 'C001',
      messageTs: '1721178000.000100',
    });
  });

  it('normalizes a bounded unique channel scope and anchor permalinks', () => {
    expect(parseSlackInteraction(submission(), now)).toEqual({
      kind: 'submit_incident_scope',
      command: {
        eventId: 'slack-view:V001',
        workspaceId: 'T001',
        channelId: 'C001',
        messageTs: '1721178000.000100',
        userId: 'U001',
        requestedTitle: 'Checkout outage',
        startedAt: '2026-07-20T02:00:00.000Z',
        endedAt: '2026-07-20T03:00:00.000Z',
        reviewerUserId: 'U002',
        evidenceRetentionDays: 30,
        channels: [
          { channelId: 'C001', role: 'PRIMARY', anchorThreadTs: [] },
          {
            channelId: 'C002',
            role: 'ADDITIONAL',
            anchorThreadTs: ['1721177000.000100'],
          },
        ],
      },
    });
  });

  it('rejects duplicate channels, foreign anchors, and unbounded windows with field errors', () => {
    let thrown: unknown;
    try {
      parseSlackInteraction(
        submission({
          startedAt: Date.parse('2026-07-01T00:00:00Z') / 1_000,
          additional: ['C001'],
          anchors: 'https://acme.slack.com/archives/C999/p1721178000000200',
        }),
        now,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidSlackInteractionError);
    expect((thrown as InvalidSlackInteractionError).fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ blockId: 'ended_at' }),
        expect.objectContaining({ blockId: 'additional_channels' }),
        expect.objectContaining({ blockId: 'anchor_threads' }),
      ]),
    );
  });
});
