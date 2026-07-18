import type { Logger } from 'pino';
import { z } from 'zod';
import type {
  GenerateIncidentReportCommand,
  GenerateIncidentReportOutcome,
} from '../application/generate-incident-report.js';

const workflowInputSchema = z
  .object({
    version: z.literal(1),
    tenantId: z.string().regex(/^T[A-Z0-9]{1,63}$/),
    incidentId: z.uuid(),
    jobId: z.string().trim().min(1).max(128),
    analysisRunId: z.string().trim().min(1).max(128),
    timelineEventCount: z.number().int().nonnegative().max(100_000),
    claimCount: z.number().int().nonnegative().max(100_000),
    openQuestionCount: z.number().int().nonnegative().max(100_000),
  })
  .strict();

export interface IncidentReportGeneratorUseCase {
  execute(
    input: GenerateIncidentReportCommand,
  ): Promise<GenerateIncidentReportOutcome>;
}

export interface IncidentReportHandlerDependencies {
  readonly generator: IncidentReportGeneratorUseCase;
  readonly logger: Logger;
}

export type IncidentReportWorkflowOutput = Readonly<{
  version: 1;
  tenantId: string;
  incidentId: string;
  jobId: string;
  analysisRunId: string;
  timelineEventCount: number;
  claimCount: number;
  openQuestionCount: number;
}> &
  GenerateIncidentReportOutcome;

export type IncidentReportHandler = (
  event: unknown,
) => Promise<IncidentReportWorkflowOutput>;

export function createIncidentReportHandler(
  dependencies: IncidentReportHandlerDependencies,
): IncidentReportHandler {
  return async (event) => {
    const input = workflowInputSchema.parse(event);
    const result = await dependencies.generator.execute({
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      analysisRunId: input.analysisRunId,
    });

    dependencies.logger.info(
      {
        tenantId: input.tenantId,
        incidentId: input.incidentId,
        jobId: input.jobId,
        analysisRunId: input.analysisRunId,
        reportStatus: result.status,
        ...('reportDraftId' in result
          ? { reportDraftId: result.reportDraftId }
          : {}),
        ...('failureCode' in result ? { failureCode: result.failureCode } : {}),
        ...(result.status === 'NEEDS_REVIEW'
          ? {
              sectionCount: result.sectionCount,
              statementCount: result.statementCount,
              openQuestionCount: result.openQuestionCount,
            }
          : {}),
      },
      'Incident report generation processed',
    );

    return { ...input, ...result };
  };
}
