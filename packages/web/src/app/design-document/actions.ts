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
/** Reference `DocumentationAgentAdapter` implementation name (mirrors the fixed default this page
 * uses for the coder/reviewer adapter names elsewhere in this app — see `features/[id]/run-actions.tsx`).
 * A future pass could expose this as an operator-editable field the same way that page does. */
const DEFAULT_DOCUMENTATION_ADAPTER_NAME = 'ClaudeDocumentationAdapter';

/** Both the `implementation_complete -> design_document_generating` lifecycle transition AND the
 * `run-design-doc` Trigger.dev task enqueue (the actual generation work) are dispatched here —
 * the lifecycle command alone only moves project state and creates the empty `design_documents`/
 * `artifact_exports` rows; without enqueuing the task, nothing would ever actually draft content
 * (see MEDIUM-2 in the Phase 17 PR review). If the enqueue call fails after the lifecycle command
 * already succeeded, the project is left at `design_document_generating` with no in-flight task —
 * recoverable by pressing the button again (`request-design-doc` has no state-mutating
 * precondition beyond the project already being at that state) or via `minicoder design-doc
 * request-run`. */
export async function generateDesignDocumentAction(
  projectId: string,
  expectedVersion: number,
): Promise<ActionResult<unknown>> {
  const lifecycleResult = await runCommandAction(() =>
    getApiClient().generateDesignDocument(projectId, expectedVersion, newIdempotencyKey()),
  );
  if (!lifecycleResult.ok) {
    revalidatePath('/design-document');
    return lifecycleResult;
  }
  const enqueueResult = await runCommandAction(() =>
    getApiClient().requestDesignDoc(
      { projectId, documentationAdapterName: DEFAULT_DOCUMENTATION_ADAPTER_NAME },
      newIdempotencyKey(),
    ),
  );
  revalidatePath('/design-document');
  return enqueueResult.ok ? lifecycleResult : enqueueResult;
}

export async function regenerateDesignDocumentAction(
  projectId: string,
  expectedVersion: number,
): Promise<ActionResult<unknown>> {
  const lifecycleResult = await runCommandAction(() =>
    getApiClient().regenerateDesignDocument(projectId, expectedVersion, newIdempotencyKey()),
  );
  if (!lifecycleResult.ok) {
    revalidatePath('/design-document');
    return lifecycleResult;
  }
  const enqueueResult = await runCommandAction(() =>
    getApiClient().requestDesignDoc(
      { projectId, documentationAdapterName: DEFAULT_DOCUMENTATION_ADAPTER_NAME },
      newIdempotencyKey(),
    ),
  );
  revalidatePath('/design-document');
  return enqueueResult.ok ? lifecycleResult : enqueueResult;
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
