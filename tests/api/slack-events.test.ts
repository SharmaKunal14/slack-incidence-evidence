import { createHmac } from 'node:crypto';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApi } from '../../src/api/server.js';
import { RequestIncidentReview } from '../../src/application/request-incident-review.js';
import type { IncidentJobPublisher } from '../../src/application/ports/incident-job-publisher.js';
import { SlackSignatureVerifier } from '../../src/integrations/slack/signature-verifier.js';

const secret = 'test-signing-secret';
const now = new Date('2026-07-17T01:00:00.000Z');
const timestamp = String(now.getTime() / 1000);

function signature(body: string): string {
  return `v0=${createHmac('sha256', secret)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')}`;
}

const apps: Array<ReturnType<typeof buildApi>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('POST /integrations/slack/events', () => {
  it('authenticates and durably accepts a supported app mention', async () => {
    const publish = vi
      .fn<IncidentJobPublisher['publish']>()
      .mockResolvedValue();
    const app = buildApi({
      logger: pino({ level: 'silent' }),
      clock: { now: () => now },
      signatureVerifier: new SlackSignatureVerifier(secret),
      requestIncidentReview: new RequestIncidentReview(
        { publish },
        { now: () => now },
        { generate: () => 'job-1' },
      ),
    });
    apps.push(app);

    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev001',
      team_id: 'T001',
      event: {
        type: 'app_mention',
        user: 'U001',
        text: '<@A001> create rca: Checkout outage',
        ts: '1721178000.000100',
        channel: 'C001',
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/slack/events',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature(body),
      },
      body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, jobId: 'job-1' });
    expect(publish).toHaveBeenCalledOnce();
  });

  it('rejects a request whose body does not match its signature', async () => {
    const publish = vi
      .fn<IncidentJobPublisher['publish']>()
      .mockResolvedValue();
    const app = buildApi({
      logger: pino({ level: 'silent' }),
      clock: { now: () => now },
      signatureVerifier: new SlackSignatureVerifier(secret),
      requestIncidentReview: new RequestIncidentReview(
        { publish },
        { now: () => now },
        { generate: () => 'job-1' },
      ),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/integrations/slack/events',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature('{"different":true}'),
      },
      body: JSON.stringify({ type: 'url_verification', challenge: 'secret' }),
    });

    expect(response.statusCode).toBe(401);
    expect(publish).not.toHaveBeenCalled();
  });
});
