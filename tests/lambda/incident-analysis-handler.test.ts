import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  createIncidentAnalysisHandler,
  type IncidentEvidenceAnalyzer,
} from '../../src/lambda/incident-analysis-handler.js';

const event = {
  version: 1 as const,
  tenantId: 'T001',
  incidentId: '2c6a2f4a-f762-41e9-9620-a07abdaa5c48',
  jobId: 'job-1',
};

function logger(): Logger {
  return { info: vi.fn() } as unknown as Logger;
}

describe('createIncidentAnalysisHandler', () => {
  it('returns only bounded counters and identifiers to the workflow', async () => {
    const execute = vi
      .fn<IncidentEvidenceAnalyzer['execute']>()
      .mockResolvedValue({
        status: 'COMPLETE',
        analysisRunId: 'run-1',
        timelineEventCount: 3,
        claimCount: 2,
        openQuestionCount: 1,
      });
    const handler = createIncidentAnalysisHandler({
      analyzer: { execute },
      logger: logger(),
    });

    await expect(handler(event)).resolves.toEqual({
      ...event,
      status: 'COMPLETE',
      analysisRunId: 'run-1',
      timelineEventCount: 3,
      claimCount: 2,
      openQuestionCount: 1,
    });
  });

  it('rejects untrusted workflow input before analysis', async () => {
    const execute = vi.fn<IncidentEvidenceAnalyzer['execute']>();
    const handler = createIncidentAnalysisHandler({
      analyzer: { execute },
      logger: logger(),
    });

    await expect(
      handler({ ...event, incidentId: 'not-a-uuid', extra: true }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(execute).not.toHaveBeenCalled();
  });
});
