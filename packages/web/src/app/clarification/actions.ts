'use server';

import { revalidatePath } from 'next/cache';
import { getApiClient } from '../../lib/api-server';
import { runCommandAction, newIdempotencyKey, type ActionResult } from '../../lib/action-result';

export async function startClarificationAction(
  clarificationSessionId: string,
  projectId: string,
  expectedVersion: number,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().startClarification(
      { clarificationSessionId, projectId, expectedVersion },
      newIdempotencyKey(),
    ),
  );
  revalidatePath('/clarification');
  return result;
}

export async function recordClarificationAnswerAction(
  clarificationQuestionId: string,
  clarificationSessionId: string,
  projectId: string,
  answer: string,
  expectedQuestionVersion: number,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().recordClarificationAnswer(
      {
        clarificationQuestionId,
        clarificationSessionId,
        projectId,
        answer,
        expectedQuestionVersion,
      },
      newIdempotencyKey(),
    ),
  );
  revalidatePath('/clarification');
  return result;
}

export async function completeClarificationAction(
  clarificationSessionId: string,
  projectId: string,
  expectedVersion: number,
): Promise<ActionResult<unknown>> {
  const result = await runCommandAction(() =>
    getApiClient().completeClarification(
      { clarificationSessionId, projectId, expectedVersion },
      newIdempotencyKey(),
    ),
  );
  revalidatePath('/clarification');
  return result;
}
