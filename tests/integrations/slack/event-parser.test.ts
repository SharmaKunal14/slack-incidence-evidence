import { describe, expect, it } from 'vitest';
import { parseSlackRequest } from '../../../src/integrations/slack/event-parser.js';

describe('parseSlackRequest', () => {
  it('parses Slack URL verification', () => {
    expect(
      parseSlackRequest({ type: 'url_verification', challenge: 'challenge-1' }),
    ).toEqual({ kind: 'url_verification', challenge: 'challenge-1' });
  });

  it('parses a review request without retaining the raw command', () => {
    expect(
      parseSlackRequest({
        type: 'event_callback',
        event_id: 'Ev001',
        team_id: 'T001',
        event: {
          type: 'app_mention',
          user: 'U001',
          text: '<@A001> generate incident review: Checkout outage',
          ts: '1721178000.000100',
          channel: 'C001',
          thread_ts: '1721177900.000050',
        },
      }),
    ).toEqual({
      kind: 'incident_review_requested',
      eventId: 'Ev001',
      workspaceId: 'T001',
      channelId: 'C001',
      messageTs: '1721178000.000100',
      threadTs: '1721177900.000050',
      userId: 'U001',
      requestedTitle: 'Checkout outage',
    });
  });

  it('acknowledges unrelated event types without creating work', () => {
    expect(
      parseSlackRequest({
        type: 'event_callback',
        event_id: 'Ev002',
        event: { type: 'reaction_added' },
      }),
    ).toEqual({ kind: 'ignored', eventType: 'reaction_added' });
  });

  it('does not create review work from private conversations', () => {
    expect(
      parseSlackRequest({
        type: 'event_callback',
        event_id: 'Ev003',
        team_id: 'T001',
        event: {
          type: 'app_mention',
          user: 'U001',
          text: '<@A001> generate incident review: Restricted incident',
          ts: '1721178000.000100',
          channel: 'G001',
        },
      }),
    ).toEqual({
      kind: 'ignored',
      eventType: 'unsupported_conversation_type',
    });
  });
});
