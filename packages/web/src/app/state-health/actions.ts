'use server';

import { revalidatePath } from 'next/cache.js';
import { getApiClient } from '../../lib/api-server';
import { runCommandAction, newIdempotencyKey, type ActionResult } from '../../lib/action-result';

export async function reconcileAction(
  projectId: string | undefined,
  all: boolean,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().reconcile({ projectId, all }, newIdempotencyKey()),
  );
  revalidatePath('/state-health');
  return result;
}
