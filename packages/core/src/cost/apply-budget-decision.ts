import type { DbClient } from '../persistence/types.js';
import type { ActorIdentity } from '../auth/types.js';
import type { CommandEnvelope } from '../commands/types.js';
import { TransactionalCommandExecutor } from '../commands/executor.js';
import { generateId } from '../commands/helpers.js';
import { RecordBudgetExceededHandler } from '../commands/handlers/automation/record-budget-exceeded.js';
import { RecordBudgetApprovalWaitingHandler } from '../commands/handlers/automation/record-budget-approval-waiting.js';
import type { BudgetEvaluation } from './budget-evaluator.js';

const recordExceededHandler = new RecordBudgetExceededHandler();
const recordWaitingHandler = new RecordBudgetApprovalWaitingHandler();

export interface ApplyBudgetDecisionParams {
  projectId: string;
  expectedVersion: number;
  actor: ActorIdentity;
  correlationId: string;
  /** Phase 16 (post-merge PR review fix, MEDIUM-2): optional feature-run attribution for a
   * hard-breach event, so a feature-run-scoped caller (budget-preflight.ts) can make the
   * resulting `workflow_events` row show up in that feature run's timeline. Ignored on the
   * soft-breach path — `RecordBudgetApprovalWaitingCommand` has no caller that needs this yet. */
  featureRunId?: string;
}

export type ApplyBudgetDecisionResult =
  | { applied: false }
  | { applied: true; outcome: 'hard_breach' | 'soft_breach' };

/**
 * Orchestration glue between evaluateBudget's verdict and the automation-control state
 * transitions: on 'ok' this is a no-op; on breach it dispatches the matching Record* command
 * via TransactionalCommandExecutor. Kept separate from the handlers themselves so the handlers
 * stay pure state-transition logic, matching the task-layer/handler-layer separation already
 * used elsewhere (e.g. complete-clarification.ts's runImpl).
 *
 * In real Phase 9+ operation the natural call site is immediately after any code path inserts a
 * cost_records row (e.g. an agent-run completion handler); Phase 8 wires only this reaction, not
 * that future producer.
 *
 * Idempotency keys include the breached policy id and params.expectedVersion (workflow_states'
 * version at read time), not just projectId — a project can legitimately breach the same
 * threshold more than once over its lifetime (e.g. cost keeps accumulating after a human
 * override returns automation to running), and each such occurrence is read against a distinct
 * workflow_states version. A key scoped to projectId alone would let
 * TransactionalCommandExecutor return the first breach's cached result for every later breach
 * within the idempotency TTL, silently leaving automation running through a second breach.
 */
export async function applyBudgetDecision(
  db: DbClient,
  evaluation: BudgetEvaluation,
  params: ApplyBudgetDecisionParams,
): Promise<ApplyBudgetDecisionResult> {
  if (evaluation.status === 'ok') return { applied: false };

  const { projectId, expectedVersion, actor, correlationId, featureRunId } = params;
  const executor = new TransactionalCommandExecutor(db);

  if (evaluation.status === 'hard_breach') {
    const payload = {
      projectId,
      expectedVersion,
      breachedPolicyId: evaluation.policy.id,
      currentSpend: evaluation.totalSpend,
      hardLimit: Number(evaluation.policy.hard_limit),
      featureRunId,
    };
    const envelope: CommandEnvelope<typeof payload> = {
      commandId: generateId(),
      idempotencyKey: `budget-exceeded:${projectId}:${evaluation.policy.id}:${expectedVersion}`,
      payload,
      actor,
      correlationId,
    };
    await executor.execute(recordExceededHandler, envelope);
    return { applied: true, outcome: 'hard_breach' };
  }

  const payload = {
    projectId,
    expectedVersion,
    breachedPolicyId: evaluation.policy.id,
    currentSpend: evaluation.totalSpend,
    softLimit: Number(evaluation.policy.soft_limit),
  };
  const envelope: CommandEnvelope<typeof payload> = {
    commandId: generateId(),
    idempotencyKey: `budget-approval-waiting:${projectId}:${evaluation.policy.id}:${expectedVersion}`,
    payload,
    actor,
    correlationId,
  };
  await executor.execute(recordWaitingHandler, envelope);
  return { applied: true, outcome: 'soft_breach' };
}
