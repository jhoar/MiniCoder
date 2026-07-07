'use server';

import { revalidatePath } from 'next/cache.js';
import { getApiClient } from '../../../lib/api-server';
import { runCommandAction, newIdempotencyKey, type ActionResult } from '../../../lib/action-result';

function refresh(featureId: string): void {
  revalidatePath(`/features/${featureId}`);
  revalidatePath('/human-required');
}

export async function selectFeatureAction(
  featureId: string,
  featureRunId: string,
  projectId: string,
  expectedVersion: number,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().selectFeature({ featureRunId, projectId, expectedVersion }, newIdempotencyKey()),
  );
  refresh(featureId);
  return result;
}

export async function resumeFeatureExecutionAction(
  featureId: string,
  featureRunId: string,
  projectId: string,
  expectedVersion: number,
  notes: string,
  disagreementId?: string,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().resumeFeatureExecution(
      { featureRunId, projectId, expectedVersion, notes, disagreementId },
      newIdempotencyKey(),
    ),
  );
  refresh(featureId);
  return result;
}

export async function retryFeatureAction(
  featureId: string,
  featureRunId: string,
  projectId: string,
  expectedVersion: number,
  notes: string,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().retryFeature(
      { featureRunId, projectId, expectedVersion, notes },
      newIdempotencyKey(),
    ),
  );
  refresh(featureId);
  return result;
}

export async function skipFeatureAction(
  featureId: string,
  featureRunId: string,
  projectId: string,
  expectedVersion: number,
  notes: string,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().skipFeature(
      { featureRunId, projectId, expectedVersion, notes },
      newIdempotencyKey(),
    ),
  );
  refresh(featureId);
  return result;
}

export async function blockFeatureAction(
  featureId: string,
  featureRunId: string,
  projectId: string,
  expectedVersion: number,
  notes: string,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().blockFeature(
      { featureRunId, projectId, expectedVersion, notes },
      newIdempotencyKey(),
    ),
  );
  refresh(featureId);
  return result;
}

export async function resolveDisagreementAction(
  featureId: string,
  featureRunId: string,
  projectId: string,
  expectedVersion: number,
  resolution: string,
  disagreementId?: string,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().resolveDisagreement(
      { featureRunId, projectId, expectedVersion, resolution, disagreementId },
      newIdempotencyKey(),
    ),
  );
  refresh(featureId);
  return result;
}

export async function requestCoderRunAction(
  featureId: string,
  featureRunId: string,
  projectId: string,
  coderAdapterName: string,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().requestCoderRun(
      { projectId, featureRunId, coderAdapterName },
      newIdempotencyKey(),
    ),
  );
  refresh(featureId);
  return result;
}

export async function requestReviewAction(
  featureId: string,
  featureRunId: string,
  projectId: string,
  reviewerAdapterName: string,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().requestReview(
      { projectId, featureRunId, reviewerAdapterName },
      newIdempotencyKey(),
    ),
  );
  refresh(featureId);
  return result;
}

export async function requestFixesAction(
  featureId: string,
  featureRunId: string,
  projectId: string,
  reviewerAdapterName: string,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().requestFixes(
      { projectId, featureRunId, reviewerAdapterName },
      newIdempotencyKey(),
    ),
  );
  refresh(featureId);
  return result;
}

export async function recomputeMergeGateAction(
  featureId: string,
  featureRunId: string,
  projectId: string,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().recomputeMergeGate({ projectId, featureRunId }, newIdempotencyKey()),
  );
  refresh(featureId);
  return result;
}

export async function mergeIfReadyAction(
  featureId: string,
  featureRunId: string,
  projectId: string,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().mergeIfReady({ featureRunId, projectId }, newIdempotencyKey()),
  );
  refresh(featureId);
  return result;
}

export async function finalizeIfGithubMergedAction(
  featureId: string,
  featureRunId: string,
  projectId: string,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().finalizeIfGithubMerged({ featureRunId, projectId }),
  );
  refresh(featureId);
  return result;
}
