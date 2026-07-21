export const demoActors = ['maya', 'arjun'] as const;
export type DemoActor = (typeof demoActors)[number];

export const demoChannels = [
  'incident-checkout',
  'security-alerts',
  'deployments',
] as const;
export type DemoChannel = (typeof demoChannels)[number];

export interface DemoMessage {
  readonly id: string;
  readonly channel: DemoChannel;
  readonly actor: DemoActor;
  readonly simulatedAt: string;
  readonly text: string;
  readonly replyTo?: string;
  readonly anchor?: boolean;
}

export const actorDisplayNames: Readonly<Record<DemoActor, string>> = {
  maya: 'Maya Chen — Incident Commander / Platform Engineer',
  arjun: 'Arjun Rao — Security Engineer',
};

export const compromisedWafScenario: readonly DemoMessage[] = [
  {
    id: 'incident-declared',
    channel: 'incident-checkout',
    actor: 'maya',
    simulatedAt: '09:03 UTC',
    anchor: true,
    text: `:rotating_light: *SEV-1 declared: EU checkout outage*

Monitoring shows a sudden increase in failed checkout attempts beginning around 08:58 UTC.

*Current impact*
• 78% checkout failure rate in the EU
• Web appears more affected than mobile
• Login and cart operations remain available
• Failures include both 403 and 502 responses

*Assigned responders*
• Maya Chen — Incident Commander / Platform
• Arjun Rao — Security

Incident: \`INC-DEMO-1042\`

No production changes without confirmation in this thread.`,
  },
  {
    id: 'security-correlation',
    channel: 'incident-checkout',
    actor: 'arjun',
    simulatedAt: '09:05 UTC',
    replyTo: 'incident-declared',
    text: 'A security alert shows an unusual login involving an account with production edge-policy access. I’m checking whether it correlates with the outage. Correlation is not yet causation.',
  },
  {
    id: 'deployment-evidence',
    channel: 'deployments',
    actor: 'maya',
    simulatedAt: '09:06 UTC',
    anchor: true,
    text: `*Deployment evidence*

\`checkout-api\` version \`2026.07.18-rc3\` completed deployment at 08:55 UTC.

Change: retry handling for payment-provider timeouts
Deployment reference: \`deploy_demo_4812\`

Automated health checks passed at 08:56. The timing is suspicious, but I am not rolling it back until we know whether failed requests are reaching the application.`,
  },
  {
    id: 'identity-anomaly',
    channel: 'security-alerts',
    actor: 'arjun',
    simulatedAt: '09:07 UTC',
    anchor: true,
    text: `*High-confidence identity anomaly*

Account: \`contractor.jlee@example.test\`
Event: production console authentication
Source: unrecognized device
Approximate location: Bucharest, Romania
Time: 08:54 UTC
Previous login: Sydney, Australia at 01:12 UTC
Alert: \`SEC-DEMO-771\`

The travel interval is impossible, but a corporate VPN has not yet been ruled out.`,
  },
  {
    id: 'edge-observation',
    channel: 'incident-checkout',
    actor: 'maya',
    simulatedAt: '09:07 UTC',
    replyTo: 'incident-declared',
    text: 'Application health is normal outside checkout. Payment-provider latency is also normal. The failure may be happening before requests reach the checkout service.',
  },
  {
    id: 'waf-audit',
    channel: 'deployments',
    actor: 'arjun',
    simulatedAt: '09:08 UTC',
    replyTo: 'deployment-evidence',
    text: `Audit history also shows a separate production WAF policy change at 08:57:42.

Resource: \`prod-eu-edge-policy\`
Actor: \`contractor.jlee@example.test\`
Change reference: \`cfg_demo_a921\`

There is no approved change ticket attached to it.`,
  },
  {
    id: 'vpn-check',
    channel: 'security-alerts',
    actor: 'maya',
    simulatedAt: '09:09 UTC',
    replyTo: 'identity-anomaly',
    text: 'Checked the approved VPN ranges. The source address is not associated with the corporate VPN.',
  },
  {
    id: 'unauthorized-change',
    channel: 'incident-checkout',
    actor: 'arjun',
    simulatedAt: '09:10 UTC',
    replyTo: 'incident-declared',
    text: 'I found an unapproved WAF configuration change at 08:57:42 UTC, 24 seconds before the first confirmed failed checkout request.',
  },
  {
    id: 'app-request-counts',
    channel: 'deployments',
    actor: 'maya',
    simulatedAt: '09:11 UTC',
    replyTo: 'deployment-evidence',
    text: 'Compared edge and application request counts. Most failed requests never reached `checkout-api`. That weakens the deployment hypothesis.',
  },
  {
    id: 'initial-checkpoint',
    channel: 'incident-checkout',
    actor: 'maya',
    simulatedAt: '09:12 UTC',
    replyTo: 'incident-declared',
    text: `*Checkpoint*

*Known*
• First confirmed failure: 08:58:06
• Unauthorized WAF change: 08:57:42
• Most affected requests return an edge-generated 403
• A checkout deployment completed at 08:55

*Unknown*
• Whether the deployment contributed
• How the account session was compromised
• Whether the actor accessed anything beyond the WAF configuration`,
  },
  {
    id: 'session-hypothesis',
    channel: 'security-alerts',
    actor: 'arjun',
    simulatedAt: '09:12 UTC',
    replyTo: 'identity-anomaly',
    text: `Authentication used a valid SSO session with MFA already satisfied. There is no evidence of password guessing.

Current hypothesis: an existing authenticated session was stolen. The acquisition method remains unknown.`,
  },
  {
    id: 'rule-analysis',
    channel: 'deployments',
    actor: 'arjun',
    simulatedAt: '09:14 UTC',
    replyTo: 'deployment-evidence',
    text: 'The changed rule is labelled `temporary-bot-filter`. It incorrectly matches a common browser header and blocks the request before it reaches the application.',
  },
  {
    id: 'permission-question',
    channel: 'security-alerts',
    actor: 'maya',
    simulatedAt: '09:15 UTC',
    replyTo: 'identity-anomaly',
    text: 'Does the account normally require production WAF access?',
  },
  {
    id: 'mobile-explanation',
    channel: 'deployments',
    actor: 'maya',
    simulatedAt: '09:16 UTC',
    replyTo: 'deployment-evidence',
    text: 'The mobile app sends different headers, which explains why mobile checkout is less affected.',
  },
  {
    id: 'excessive-permission',
    channel: 'security-alerts',
    actor: 'arjun',
    simulatedAt: '09:17 UTC',
    replyTo: 'identity-anomaly',
    text: 'No. The contractor role inherited that permission through a broader operations group. That is an access-control weakness and a contributing factor, but it did not itself trigger the outage.',
  },
  {
    id: 'isolated-rule',
    channel: 'deployments',
    actor: 'arjun',
    simulatedAt: '09:18 UTC',
    replyTo: 'deployment-evidence',
    text: 'The remaining WAF policy matches the last approved revision. The unauthorized rule is isolated, so it can be disabled without reverting the complete policy.',
  },
  {
    id: 'deployment-conclusion',
    channel: 'deployments',
    actor: 'maya',
    simulatedAt: '09:20 UTC',
    replyTo: 'deployment-evidence',
    text: `*Conclusion*

The application deployment was coincidental, not causal. No rollback required.

*Evidence*
• Health checks passed after deployment
• Failed requests were blocked at the edge
• The failure pattern matches the unauthorized WAF rule
• The same application version remains healthy on unaffected routes`,
  },
  {
    id: 'containment',
    channel: 'security-alerts',
    actor: 'arjun',
    simulatedAt: '09:21 UTC',
    replyTo: 'identity-anomaly',
    text: `*Containment completed*

• Account disabled
• Active sessions revoked at 09:20:31
• Identity logs preserved
• WAF audit history preserved

No evidence currently indicates access to databases, customer records, source code, secrets, or payment systems. This conclusion is provisional until the audit review is complete.`,
  },
  {
    id: 'separate-workstreams',
    channel: 'security-alerts',
    actor: 'maya',
    simulatedAt: '09:22 UTC',
    replyTo: 'identity-anomaly',
    text: 'Approved. Keep the security investigation separate from service mitigation. I’m returning to the incident channel to authorize the WAF change.',
  },
  {
    id: 'mitigation-proposed',
    channel: 'incident-checkout',
    actor: 'arjun',
    simulatedAt: '09:23 UTC',
    anchor: true,
    text: `*Proposed mitigation*

Disable only the unauthorized \`temporary-bot-filter\` rule.

Before making the change:
• Current policy snapshot captured as \`policy_demo_08f1\`
• Last approved revision verified
• Unauthorized rule configuration preserved for investigation
• Rollback point confirmed

Requesting IC approval.`,
  },
  {
    id: 'mitigation-approved',
    channel: 'incident-checkout',
    actor: 'maya',
    simulatedAt: '09:24 UTC',
    replyTo: 'mitigation-proposed',
    text: 'Approved. Disable only the identified rule. Do not delete it or modify other policy rules.',
  },
  {
    id: 'rule-disabled',
    channel: 'incident-checkout',
    actor: 'arjun',
    simulatedAt: '09:27 UTC',
    replyTo: 'mitigation-proposed',
    text: 'Unauthorized rule disabled at 09:27:14. No other WAF rules changed.',
  },
  {
    id: 'synthetic-pass',
    channel: 'incident-checkout',
    actor: 'maya',
    simulatedAt: '09:29 UTC',
    replyTo: 'mitigation-proposed',
    text: 'Synthetic checkout passed from Frankfurt. Live 403 rate is falling. Holding at SEV-1 until two healthy validation windows complete.',
  },
  {
    id: 'error-baseline',
    channel: 'incident-checkout',
    actor: 'arjun',
    simulatedAt: '09:32 UTC',
    replyTo: 'mitigation-proposed',
    text: 'Edge-generated 403 rate has returned to baseline. No new suspicious policy activity detected.',
  },
  {
    id: 'validation-one',
    channel: 'incident-checkout',
    actor: 'maya',
    simulatedAt: '09:35 UTC',
    replyTo: 'mitigation-proposed',
    text: `*Validation window 1 passed*

• EU checkout success rate: 98.7%
• Web and mobile synthetic checkouts passed
• Payment-provider latency remains normal
• No new 403 spike`,
  },
  {
    id: 'validation-two',
    channel: 'incident-checkout',
    actor: 'maya',
    simulatedAt: '09:41 UTC',
    replyTo: 'mitigation-proposed',
    text: '*Validation window 2 passed*\n\nService is stable. Moving the incident to monitoring.',
  },
  {
    id: 'incident-resolved',
    channel: 'incident-checkout',
    actor: 'maya',
    simulatedAt: '09:45 UTC',
    anchor: true,
    text: `*Incident resolved — \`INC-DEMO-1042\`*

From 08:58 until approximately 09:32 UTC, 78% of EU web checkout attempts failed.

A valid but compromised contractor SSO session was used to create and broaden an unauthorized production WAF rule. The rule incorrectly matched legitimate browser requests and returned 403 responses before they reached the checkout service.

The rule was disabled at 09:27, and checkout recovered by approximately 09:32.

A checkout deployment completed shortly before the incident, but the available evidence shows it was coincidental rather than causal.`,
  },
  {
    id: 'security-conclusion',
    channel: 'incident-checkout',
    actor: 'arjun',
    simulatedAt: '09:47 UTC',
    replyTo: 'incident-resolved',
    text: `*Security conclusion*

*Established*
• The contractor did not authorize the activity
• A valid authenticated session performed the WAF change
• The account had unnecessary production permissions

*Not established*
• How the authenticated session was obtained
• Whether the contractor device was compromised

No evidence currently shows access to customer data, databases, secrets, source code, or payment systems.`,
  },
  {
    id: 'secondary-failure',
    channel: 'incident-checkout',
    actor: 'maya',
    simulatedAt: '09:50 UTC',
    replyTo: 'incident-resolved',
    text: '*Secondary failure*\n\nThe smaller 502 spike was caused by retry saturation after clients repeatedly retried blocked checkout requests. It was an impact amplifier, not a separate attack.',
  },
  {
    id: 'root-cause-classification',
    channel: 'incident-checkout',
    actor: 'arjun',
    simulatedAt: '09:52 UTC',
    replyTo: 'incident-resolved',
    text: `*Root-cause classification*

• Trigger: unauthorized production WAF rule
• Security event: compromised SSO session
• Contributing factor: excessive contractor permissions
• Impact amplifier: aggressive client retries
• Rejected hypothesis: checkout deployment caused the outage
• Open question: how the SSO session was acquired`,
  },
  {
    id: 'follow-up-actions',
    channel: 'incident-checkout',
    actor: 'maya',
    simulatedAt: '09:55 UTC',
    replyTo: 'incident-resolved',
    text: `*Follow-up actions*

1. Remove production WAF permissions from contractor roles — Arjun
2. Require step-up authentication for production policy changes — Arjun
3. Alert on edge-policy changes without approved change references — Arjun
4. Add automated WAF snapshot and rollback tooling — Maya
5. Reduce retry amplification in checkout clients — Maya
6. Complete forensic review of activity during the compromised session — Arjun`,
  },
];

export function formatDemoMessage(message: DemoMessage): string {
  return `*[SIMULATED ${message.simulatedAt}]* ${message.text}`;
}

export function validateDemoScenario(messages: readonly DemoMessage[]): void {
  const seen = new Map<string, DemoMessage>();
  for (const message of messages) {
    if (seen.has(message.id)) {
      throw new Error(`Duplicate demo message ID: ${message.id}`);
    }
    if (message.replyTo !== undefined) {
      const parent = seen.get(message.replyTo);
      if (parent === undefined) {
        throw new Error(
          `Demo reply ${message.id} references a parent that has not been posted`,
        );
      }
      if (parent.replyTo !== undefined) {
        throw new Error(`Demo reply ${message.id} must target a root message`);
      }
      if (parent.channel !== message.channel) {
        throw new Error(`Demo reply ${message.id} crosses Slack channels`);
      }
    }
    seen.set(message.id, message);
  }
}

validateDemoScenario(compromisedWafScenario);
