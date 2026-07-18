import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  createIncidentReportHandler,
  type IncidentReportGeneratorUseCase,
} from '../../src/lambda/incident-report-handler.js';

const event = {
  version: 1 as const,
  tenantId: 'T001',
  incidentId: '2c6a2f4a-f762-41e9-9620-a07abdaa5c48',
  jobId: 'job-1',
  analysisRunId: 'analysis-1',
  timelineEventCount: 3,
  claimCount: 2,
  openQuestionCount: 1,
};

describe('createIncidentReportHandler', () => {
  it('returns only bounded identifiers and counters to the workflow', async () => {
    const execute = vi
      .fn<IncidentReportGeneratorUseCase['execute']>()
      .mockResolvedValue({
        status: 'NEEDS_REVIEW',
        reportDraftId: '7df1bcac-5583-4cd6-91db-981989f4c482',
        sectionCount: 10,
        statementCount: 5,
        openQuestionCount: 1,
      });
    const handler = createIncidentReportHandler({
      generator: { execute },
      logger: { info: vi.fn() } as unknown as Logger,
    });

    await expect(handler(event)).resolves.toEqual({
      ...event,
      status: 'NEEDS_REVIEW',
      reportDraftId: '7df1bcac-5583-4cd6-91db-981989f4c482',
      sectionCount: 10,
      statementCount: 5,
    });
    expect(execute).toHaveBeenCalledWith({
      tenantId: event.tenantId,
      incidentId: event.incidentId,
      analysisRunId: event.analysisRunId,
    });
  });

  it('rejects additional workflow fields', async () => {
    const execute = vi.fn<IncidentReportGeneratorUseCase['execute']>();
    const handler = createIncidentReportHandler({
      generator: { execute },
      logger: { info: vi.fn() } as unknown as Logger,
    });

    await expect(
      handler({ ...event, rawEvidence: 'must-not-pass' }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(execute).not.toHaveBeenCalled();
  });
});
