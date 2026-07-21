import { describe, expect, it } from 'vitest';
import {
  compromisedWafScenario,
  demoActors,
  demoChannels,
  formatDemoMessage,
  validateDemoScenario,
} from '../../src/demo/slack-cybersecurity-scenario.js';
import { previewSlackIncident } from '../../src/demo/slack-incident-seeder.js';

describe('compromised WAF Slack demo scenario', () => {
  it('contains exactly two actors across exactly three channels', () => {
    expect(
      new Set(compromisedWafScenario.map((message) => message.actor)),
    ).toEqual(new Set(demoActors));
    expect(
      new Set(compromisedWafScenario.map((message) => message.channel)),
    ).toEqual(new Set(demoChannels));
  });

  it('has valid root-thread relationships and five anchors', () => {
    expect(() => validateDemoScenario(compromisedWafScenario)).not.toThrow();
    expect(
      compromisedWafScenario.filter((message) => message.anchor),
    ).toHaveLength(5);
  });

  it('marks every message as simulated', () => {
    for (const message of compromisedWafScenario) {
      expect(formatDemoMessage(message)).toMatch(
        /^\*\[SIMULATED \d{2}:\d{2} UTC\]\*/u,
      );
    }
  });

  it('rejects a reply whose root has not been posted', () => {
    expect(() =>
      validateDemoScenario([
        {
          id: 'reply',
          channel: 'incident-checkout',
          actor: 'maya',
          simulatedAt: '09:00 UTC',
          text: 'reply',
          replyTo: 'missing',
        },
      ]),
    ).toThrow(/has not been posted/u);
  });

  it('previews unique suffixed channel names without executing', () => {
    const preview = previewSlackIncident('buildweek2');
    expect(preview).toContain('#incident-checkout-buildweek2');
    expect(preview).toContain('No Slack API calls were made');
  });
});
