import type { Logger } from 'pino';
import { z } from 'zod';
import type {
  AnalyzeIncidentEvidenceCommand,
  AnalyzeIncidentEvidenceOutcome,
} from '../application/analyze-incident-evidence.js';

const workflowInputSchema = z
  .object({
    version: z.literal(1),
    tenantId: z.string().regex(/^T[A-Z0-9]{1,63}$/),
    incidentId: z.uuid(),
    jobId: z.string().trim().min(1).max(128),
  })
  .strict();

export interface IncidentEvidenceAnalyzer {
  execute(
    input: AnalyzeIncidentEvidenceCommand,
  ): Promise<AnalyzeIncidentEvidenceOutcome>;
}

export interface IncidentAnalysisHandlerDependencies {
  readonly analyzer: IncidentEvidenceAnalyzer;
  readonly logger: Logger;
}

export type IncidentAnalysisWorkflowOutput = Readonly<{
  version: 1;
  tenantId: string;
  incidentId: string;
  jobId: string;
}> &
  AnalyzeIncidentEvidenceOutcome;

export type IncidentAnalysisHandler = (
  event: unknown,
) => Promise<IncidentAnalysisWorkflowOutput>;

export function createIncidentAnalysisHandler(
  dependencies: IncidentAnalysisHandlerDependencies,
): IncidentAnalysisHandler {
  return async (event) => {
    const input = workflowInputSchema.parse(event);
    const result = await dependencies.analyzer.execute({
      tenantId: input.tenantId,
      incidentId: input.incidentId,
    });

    dependencies.logger.info(
      {
        tenantId: input.tenantId,
        incidentId: input.incidentId,
        jobId: input.jobId,
        analysisStatus: result.status,
        ...('analysisRunId' in result
          ? { analysisRunId: result.analysisRunId }
          : {}),
        ...('failureCode' in result ? { failureCode: result.failureCode } : {}),
        ...(result.status === 'COMPLETE'
          ? {
              timelineEventCount: result.timelineEventCount,
              claimCount: result.claimCount,
              openQuestionCount: result.openQuestionCount,
            }
          : {}),
      },
      'Incident evidence analysis processed',
    );

    return { ...input, ...result };
  };
}
