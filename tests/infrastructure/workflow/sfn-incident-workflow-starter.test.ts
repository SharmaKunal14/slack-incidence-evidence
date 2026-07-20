import type { SFNClient } from '@aws-sdk/client-sfn';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { describe, expect, it, vi } from 'vitest';
import {
  executionName,
  SfnIncidentWorkflowStarter,
} from '../../../src/infrastructure/workflow/sfn-incident-workflow-starter.js';

const input = {
  tenantId: 'workspace-T001',
  incidentId: 'incident-001',
  jobId: 'job-001',
  sourceIds: [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
  ],
};

type Send = (command: unknown) => Promise<unknown>;

function createClient(send: Send): SFNClient {
  return { send } as unknown as SFNClient;
}

describe('SfnIncidentWorkflowStarter', () => {
  it('starts a versioned workflow with a deterministic incident execution name', async () => {
    const send = vi
      .fn<Send>()
      .mockResolvedValue({ executionArn: 'execution-arn' });
    const starter = new SfnIncidentWorkflowStarter(
      createClient(send),
      'arn:aws:states:ap-southeast-2:123456789012:stateMachine:incident',
    );

    await starter.start(input);

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(StartExecutionCommand);
    expect((command as StartExecutionCommand).input).toEqual({
      stateMachineArn:
        'arn:aws:states:ap-southeast-2:123456789012:stateMachine:incident',
      name: executionName(input),
      input: JSON.stringify({ version: 1, ...input }),
    });
    expect(executionName(input)).toMatch(/^incident-[a-f0-9]{64}$/);
    expect(executionName(input)).toHaveLength(73);
  });

  it('uses incident identity rather than delivery identity for idempotency', () => {
    const differentDelivery = { ...input, jobId: 'a-different-delivery' };
    expect(executionName(input)).toBe(executionName(differentDelivery));
    expect(executionName(input)).not.toBe(
      executionName({ ...input, incidentId: 'incident-002' }),
    );
  });

  it('treats an existing execution as a successful duplicate request', async () => {
    const duplicate = new Error('execution already exists');
    duplicate.name = 'ExecutionAlreadyExists';
    const send = vi.fn<Send>().mockRejectedValue(duplicate);
    const starter = new SfnIncidentWorkflowStarter(
      createClient(send),
      'state-machine-arn',
    );

    await expect(starter.start(input)).resolves.toBeUndefined();
  });

  it('propagates non-idempotent AWS failures for SQS redelivery', async () => {
    const send = vi.fn<Send>().mockRejectedValue(new Error('throttled'));
    const starter = new SfnIncidentWorkflowStarter(
      createClient(send),
      'state-machine-arn',
    );

    await expect(starter.start(input)).rejects.toThrow('throttled');
  });
});
