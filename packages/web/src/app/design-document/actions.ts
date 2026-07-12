'use server';

import { revalidatePath } from 'next/cache';
import { getApiClient } from '../../lib/api-server';
import { runCommandAction, newIdempotencyKey, type ActionResult } from '../../lib/action-result';

/**
 * Phase 17: the buttons this page's `page.tsx` used to render disabled ("Not available yet — no
 * backend command exists") now dispatch real state-machine commands via the Orchestrator API, the
 * same Server-Action shape every other command-issuing Web UI page already uses (see
 * `state-health/actions.ts`).
 */
export async function generateDesignDocumentAction(
  projectId: string,
  expectedVersion: number,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().generateDesignDocument(projectId, expectedVersion, newIdempotencyKey()),
  );
  revalidatePath('/design-document');
  return result;
}

export async function regenerateDesignDocumentAction(
  projectId: string,
  expectedVersion: number,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().regenerateDesignDocument(projectId, expectedVersion, newIdempotencyKey()),
  );
  revalidatePath('/design-document');
  return result;
}

export async function requestDesignDocumentRevisionAction(
  projectId: string,
  expectedVersion: number,
  designDocumentId: string,
  notes: string | undefined,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().requestDesignDocumentRevision(
      projectId,
      expectedVersion,
      designDocumentId,
      notes,
      newIdempotencyKey(),
    ),
  );
  revalidatePath('/design-document');
  return result;
}

export async function approveDesignDocumentAction(
  projectId: string,
  expectedVersion: number,
  designDocumentId: string,
  notes: string | undefined,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().approveDesignDocument(
      projectId,
      expectedVersion,
      designDocumentId,
      notes,
      newIdempotencyKey(),
    ),
  );
  revalidatePath('/design-document');
  return result;
}
