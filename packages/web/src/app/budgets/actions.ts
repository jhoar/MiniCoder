'use server';

import { revalidatePath } from 'next/cache';
import { getApiClient } from '../../lib/api-server';
import { runCommandAction, newIdempotencyKey, type ActionResult } from '../../lib/action-result';

export async function approveBudgetOverrideAction(
  projectId: string,
  expectedVersion: number,
  overrideReason: string,
  approvedBudgetPolicyId: string,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().approveBudgetOverride(
      { projectId, expectedVersion, overrideReason, approvedBudgetPolicyId },
      newIdempotencyKey(),
    ),
  );
  revalidatePath('/budgets');
  revalidatePath('/dashboard');
  return result;
}
