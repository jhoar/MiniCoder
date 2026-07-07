'use server';

import { revalidatePath } from 'next/cache.js';
import { getApiClient } from '../../lib/api-server';
import { runCommandAction, newIdempotencyKey, type ActionResult } from '../../lib/action-result';

export async function submitPlanForApprovalAction(
  planId: string,
  projectId: string,
  expectedVersion: number,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().submitPlanForApproval(
      { planId, projectId, expectedVersion },
      newIdempotencyKey(),
    ),
  );
  revalidatePath('/planning');
  return result;
}

export async function approvePlanAction(
  planId: string,
  projectId: string,
  expectedVersion: number,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().approvePlan({ planId, projectId, expectedVersion }, newIdempotencyKey()),
  );
  revalidatePath('/planning');
  return result;
}

export async function activatePlanAction(
  planId: string,
  projectId: string,
  expectedVersion: number,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().activatePlan({ planId, projectId, expectedVersion }, newIdempotencyKey()),
  );
  revalidatePath('/planning');
  return result;
}

export async function exportPlanAction(
  planId: string,
  projectId: string,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().exportPlan({ planId, projectId }, newIdempotencyKey()),
  );
  revalidatePath('/planning');
  return result;
}

export async function exportBacklogAction(
  planId: string,
  projectId: string,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().exportBacklog({ planId, projectId }, newIdempotencyKey()),
  );
  revalidatePath('/planning');
  return result;
}
