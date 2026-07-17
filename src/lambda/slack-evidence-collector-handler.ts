import { z } from 'zod';
import type { Logger } from 'pino';
import type {
  CollectSlackThreadPageInput,
  CollectSlackThreadPageResult,
} from '../application/collect-slack-thread-page.js';

const workflowInputSchema = z
  .object({
    version: z.literal(1),
    tenantId: z.string().regex(/^T[A-Z0-9]{1,63}$/),
    incidentId: z.uuid(),
    jobId: z.string().trim().min(1).max(128),
  })
  .strict();

export interface SlackThreadPageCollector {
  execute(
    input: CollectSlackThreadPageInput,
  ): Promise<CollectSlackThreadPageResult>;
}

export interface SlackEvidenceCollectorHandlerDependencies {
  readonly collector: SlackThreadPageCollector;
  readonly logger: Logger;
}

export type SlackEvidenceCollectorHandler = (
  event: unknown,
) => Promise<SlackEvidenceCollectorWorkflowOutput>;

export type SlackEvidenceCollectorWorkflowOutput = Readonly<{
  version: 1;
  tenantId: string;
  incidentId: string;
  jobId: string;
}> &
  CollectSlackThreadPageResult;

export function createSlackEvidenceCollectorHandler(
  dependencies: SlackEvidenceCollectorHandlerDependencies,
): SlackEvidenceCollectorHandler {
  return async (event) => {
    const input = workflowInputSchema.parse(event);
    const result = await dependencies.collector.execute({
      tenantId: input.tenantId,
      incidentId: input.incidentId,
    });

    dependencies.logger.info(
      {
        tenantId: input.tenantId,
        incidentId: input.incidentId,
        jobId: input.jobId,
        collectionStatus: result.status,
        ...('messagesCollected' in result
          ? {
              messagesCollected: result.messagesCollected,
              pagesCollected: result.pagesCollected,
            }
          : {}),
        ...('failureCode' in result ? { failureCode: result.failureCode } : {}),
      },
      'Slack thread evidence collection page processed',
    );

    return { ...input, ...result };
  };
}
