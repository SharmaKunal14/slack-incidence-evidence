import { createHash } from 'node:crypto';
import { StartExecutionCommand, type SFNClient } from '@aws-sdk/client-sfn';
import type {
  IncidentWorkflowStarter,
  StartIncidentWorkflowInput,
} from '../../application/ports/incident-workflow-starter.js';

/**
 * Step Functions Standard workflow adapter.
 *
 * Standard workflow execution names are idempotency keys while an execution is
 * running and remain unavailable for reuse after completion. The name is based
 * on the durable incident identity—not the delivery/job identity—so duplicate
 * Slack events and SQS redeliveries converge on one orchestration.
 */
export class SfnIncidentWorkflowStarter implements IncidentWorkflowStarter {
  public constructor(
    private readonly client: SFNClient,
    private readonly stateMachineArn: string,
  ) {
    if (stateMachineArn.trim().length === 0) {
      throw new Error('State machine ARN must not be empty');
    }
  }

  public async start(input: StartIncidentWorkflowInput): Promise<void> {
    try {
      await this.client.send(
        new StartExecutionCommand({
          stateMachineArn: this.stateMachineArn,
          name: executionName(input),
          input: JSON.stringify({
            version: 1,
            tenantId: input.tenantId,
            incidentId: input.incidentId,
            jobId: input.jobId,
            ...(input.sourceIds === undefined
              ? {}
              : { sourceIds: input.sourceIds }),
          }),
        }),
      );
    } catch (error) {
      // The worker can be retried after StartExecution succeeded but before its
      // response was observed. Treat only AWS's explicit duplicate-name error
      // as success; throttling, IAM, and malformed requests must be retried.
      if (isExecutionAlreadyExists(error)) {
        return;
      }
      throw error;
    }
  }
}

export function executionName(
  input: Pick<StartIncidentWorkflowInput, 'tenantId' | 'incidentId'>,
): string {
  const digest = createHash('sha256')
    .update(input.tenantId, 'utf8')
    .update('\0', 'utf8')
    .update(input.incidentId, 'utf8')
    .digest('hex');
  return `incident-${digest}`;
}

function isExecutionAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ExecutionAlreadyExists' ||
      error.name === 'ExecutionAlreadyExistsException')
  );
}
