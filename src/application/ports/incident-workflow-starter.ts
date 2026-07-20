export interface StartIncidentWorkflowInput {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly jobId: string;
  readonly sourceIds?: readonly string[];
}

/**
 * Starts the durable orchestration for an incident.
 *
 * Implementations must be idempotent for the same incident. Queue delivery is
 * at-least-once, and a retry can occur after the incident transaction commits
 * but before the workflow-start response reaches the caller.
 */
export interface IncidentWorkflowStarter {
  start(input: StartIncidentWorkflowInput): Promise<void>;
}
