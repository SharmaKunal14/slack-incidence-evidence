import { describe, expect, it } from 'vitest';
import { assessTerraformPlan } from '../../src/deployment/terraform-plan-policy.js';

describe('Terraform deployment plan policy', () => {
  it('counts non-destructive changes', () => {
    expect(
      assessTerraformPlan({
        resource_changes: [
          {
            address: 'aws_lambda_function.api',
            change: { actions: ['update'] },
          },
          { address: 'aws_sqs_queue.jobs', change: { actions: ['no-op'] } },
          {
            address: 'aws_cloudwatch_metric_alarm.new',
            change: { actions: ['create'] },
          },
        ],
      }),
    ).toEqual({
      createCount: 1,
      updateCount: 1,
      deleteCount: 0,
      destructiveAddresses: [],
    });
  });

  it('treats replacement as destructive', () => {
    expect(
      assessTerraformPlan({
        resource_changes: [
          {
            address: 'aws_sqs_queue.jobs',
            change: { actions: ['delete', 'create'] },
          },
        ],
      }).destructiveAddresses,
    ).toEqual(['aws_sqs_queue.jobs']);
  });

  it('rejects malformed plan input', () => {
    expect(() => assessTerraformPlan({ resource_changes: 'all' })).toThrow();
  });
});
