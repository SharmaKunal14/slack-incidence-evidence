import { z } from 'zod';
import type { Logger } from 'pino';
import type {
  CollectSlackThreadPageInput,
  CollectSlackThreadPageResult,
} from '../application/collect-slack-thread-page.js';
import type {
  CollectSlackSourcePageInput,
  CollectSlackSourcePageResult,
} from '../application/collect-slack-source-page.js';

const workflowInputSchema = z
  .object({
    version: z.literal(1),
    tenantId: z.string().regex(/^T[A-Z0-9]{1,63}$/),
    incidentId: z.uuid(),
    jobId: z.string().trim().min(1).max(128),
    sourceId: z.uuid().optional(),
  })
  .strict();

export interface SlackThreadPageCollector {
  execute(
    input: CollectSlackThreadPageInput,
  ): Promise<CollectSlackThreadPageResult>;
}

export interface SlackEvidenceCollectorHandlerDependencies {
  readonly collector?: SlackThreadPageCollector;
  readonly sourceCollector?: {
    execute(
      input: CollectSlackSourcePageInput,
    ): Promise<CollectSlackSourcePageResult>;
  };
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
  sourceId?: string;
}> &
  (CollectSlackThreadPageResult | CollectSlackSourcePageResult);

export function createSlackEvidenceCollectorHandler(
  dependencies: SlackEvidenceCollectorHandlerDependencies,
): SlackEvidenceCollectorHandler {
  return async (event) => {
    const input = workflowInputSchema.parse(event);
    const result =
      input.sourceId === undefined
        ? await requireThreadCollector(dependencies).execute({
            tenantId: input.tenantId,
            incidentId: input.incidentId,
          })
        : await requireSourceCollector(dependencies).execute({
            tenantId: input.tenantId,
            incidentId: input.incidentId,
            sourceId: input.sourceId,
          });

    dependencies.logger.info(
      {
        tenantId: input.tenantId,
        incidentId: input.incidentId,
        jobId: input.jobId,
        collectionStatus: result.status,
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
        ...('sourceStatus' in result
          ? { sourceStatus: result.sourceStatus }
          : {}),
        ...('messagesCollected' in result
          ? {
              messagesCollected: result.messagesCollected,
              pagesCollected: result.pagesCollected,
            }
          : {}),
        ...('failureCode' in result ? { failureCode: result.failureCode } : {}),
      },
      'Slack evidence collection page processed',
    );

    return {
      version: input.version,
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      jobId: input.jobId,
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      ...result,
    };
  };
}

function requireThreadCollector(
  dependencies: SlackEvidenceCollectorHandlerDependencies,
): SlackThreadPageCollector {
  if (dependencies.collector === undefined) {
    throw new Error('Legacy Slack thread collector is not configured');
  }
  return dependencies.collector;
}

function requireSourceCollector(
  dependencies: SlackEvidenceCollectorHandlerDependencies,
): NonNullable<SlackEvidenceCollectorHandlerDependencies['sourceCollector']> {
  if (dependencies.sourceCollector === undefined) {
    throw new Error('Slack source collector is not configured');
  }
  return dependencies.sourceCollector;
}
