'use server';

import { revalidatePath } from 'next/cache.js';
import { getApiClient } from '../../lib/api-server';
import { runCommandAction, newIdempotencyKey, type ActionResult } from '../../lib/action-result';

export async function selectFeatureAction(
  featureRunId: string,
  projectId: string,
  expectedVersion: number,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().selectFeature({ featureRunId, projectId, expectedVersion }, newIdempotencyKey()),
  );
  revalidatePath('/features');
  return result;
}
