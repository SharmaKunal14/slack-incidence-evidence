import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  createSlackEvidenceCollectorHandler,
  type SlackThreadPageCollector,
} from '../../src/lambda/slack-evidence-collector-handler.js';

const event = {
  version: 1 as const,
  tenantId: 'T001',
  incidentId: '2c6a2f4a-f762-41e9-9620-a07abdaa5c48',
  jobId: 'job-1',
};

function logger(): Logger {
  return { info: vi.fn() } as unknown as Logger;
}

describe('createSlackEvidenceCollectorHandler', () => {
  it('returns only bounded workflow state after collecting a page', async () => {
    const execute = vi
      .fn<SlackThreadPageCollector['execute']>()
      .mockResolvedValue({
        status: 'CONTINUE',
        messagesCollected: 15,
        pagesCollected: 1,
      });
    const handler = createSlackEvidenceCollectorHandler({
      collector: { execute },
      logger: logger(),
    });

    await expect(handler(event)).resolves.toEqual({
      ...event,
      status: 'CONTINUE',
      messagesCollected: 15,
      pagesCollected: 1,
    });
    expect(execute).toHaveBeenCalledWith({
      tenantId: 'T001',
      incidentId: event.incidentId,
    });
  });

  it('rejects malformed workflow input before invoking collection', async () => {
    const execute = vi.fn<SlackThreadPageCollector['execute']>();
    const handler = createSlackEvidenceCollectorHandler({
      collector: { execute },
      logger: logger(),
    });

    await expect(
      handler({ ...event, tenantId: 'invalid', unexpected: true }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(execute).not.toHaveBeenCalled();
  });
});
