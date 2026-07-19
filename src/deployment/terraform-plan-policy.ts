import { z } from 'zod';

const changeSchema = z.object({
  actions: z.array(
    z.enum(['no-op', 'create', 'read', 'update', 'delete', 'forget']),
  ),
});

const planSchema = z.object({
  resource_changes: z
    .array(
      z.object({
        address: z.string().min(1).max(1_024),
        change: changeSchema,
      }),
    )
    .default([]),
});

export interface TerraformPlanAssessment {
  readonly createCount: number;
  readonly updateCount: number;
  readonly deleteCount: number;
  readonly destructiveAddresses: readonly string[];
}

export function assessTerraformPlan(value: unknown): TerraformPlanAssessment {
  const plan = planSchema.parse(value);
  let createCount = 0;
  let updateCount = 0;
  let deleteCount = 0;
  const destructiveAddresses: string[] = [];
  for (const resource of plan.resource_changes) {
    if (resource.change.actions.includes('create')) {
      createCount += 1;
    }
    if (resource.change.actions.includes('update')) {
      updateCount += 1;
    }
    if (resource.change.actions.includes('delete')) {
      deleteCount += 1;
      destructiveAddresses.push(resource.address);
    }
  }
  return {
    createCount,
    updateCount,
    deleteCount,
    destructiveAddresses,
  };
}
