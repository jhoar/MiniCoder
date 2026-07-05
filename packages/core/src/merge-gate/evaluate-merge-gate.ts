import type { TxClient } from '../persistence/types.js';
import { generateId, isoNow, parseJsonField } from '../commands/helpers.js';
import { getPullRequestByFeatureRun } from '../commands/handlers/github/pull-request-row.js';
import { evaluateBudget } from '../cost/budget-evaluator.js';
import { BudgetScope, FindingSeverity } from '../domain/states.js';
import { CommandError } from '../commands/types.js';
import { resolveBlockingLabelsPolicy } from './constants.js';

export type MergeGateDecision = 'approved' | 'rejected';

/**
 * Thrown by `RecordApprovedByPolicyHandler`/`MergeIfReadyHandler` when `evaluateMergeGate()`
 * returns `rejected`. Carries the structured `reasons` array directly (code-review fix) rather
 * than requiring callers to parse it back out of `CommandError.problem.detail` prose — a caller
 * that only has the rendered detail string has no reliable way to recover the individual reasons
 * if any reason's own text happens to contain the `'; '`/`': '` delimiters used to join them.
 */
export class MergeGateBlockedError extends CommandError {
  constructor(
    public readonly reasons: string[],
    featureRunId: string,
    correlationId?: string,
  ) {
    super({
      type: 'merge-gate-blocked',
      title: 'Merge gate did not pass',
      status: 409,
      detail: `Merge gate rejected feature run ${featureRunId}: ${reasons.join('; ')}`,
      instance: correlationId,
    });
  }
}

export interface MergeGateEvaluationResult {
  evaluationId: string;
  decision: MergeGateDecision;
  reasons: string[];
  ciStatus: string | null;
  reviewStatus: string | null;
  unresolvedBlockingFindings: number;
  budgetStatus: string | null;
  humanApprovalRequired: boolean;
  humanApprovalId: string | null;
  branchProtectionOk: boolean;
}

export interface EvaluateMergeGateParams {
  featureRunId: string;
  projectId: string;
  featureRequestId: string;
}

interface UnresolvedFindingsRow {
  count: number;
}

interface OutstandingHumanApprovalRow {
  id: string;
  decision: string;
}

/**
 * The Merge Gate (docs/01 §12, docs/06 Phase 12): evaluates every documented precondition and
 * writes a structured `merge_gate_evaluations` evidence record — win or lose — so every merge
 * decision is auditable and replayable. Callers (`RecordApprovedByPolicyHandler`,
 * `MergeIfReadyHandler`) run this *inside its own transaction, separate from the state transition
 * it gates* (a two-phase design, not one atomic unit): phase one (this function) always commits
 * the evidence row regardless of outcome; only a passing evaluation proceeds to phase two, a
 * second transaction that claims the idempotency key and performs the actual transition. A single
 * all-or-nothing transaction covering both would roll the evidence write back along with a
 * deliberately-not-taken transition on rejection, losing the audit trail for exactly the runs
 * where it matters most — see each handler's own doc comment for the full rationale.
 *
 * Deliberately NOT evaluated: `pull_requests.conversations_resolved`. GitHub's REST API has no
 * "conversations resolved" flag (only GraphQL's `reviewThreads.nodes[].isResolved` exposes it —
 * tracked in issue #36), so `OctokitGitHubClient` reports a conservative, fail-closed hardcoded
 * `false` for every real PR. Wiring that placeholder into a hard gate here would make every real
 * merge permanently blocked, not a real precondition — the architectural fitness test
 * `no-conversations-resolved-gate.test.ts` exists precisely to force a visible, deliberate choice
 * before any decision-making code references this field, and this file deliberately stays off its
 * allow-list. This remains documented, tracked future work (docs/01 §12), not silently dropped.
 *
 * `branch_protection_ok` is derived from the observed `pull_requests.mergeable` flag (GitHub's own
 * mergeability computation already accounts for required status checks and branch-protection
 * rules) — there is no separate branch-protection-rules API call in this implementation;
 * `minicoder github simulate-branch-protection-ok` remains dev-tooling only (docs/01 §5.7) and is
 * not consumed here.
 */
export async function evaluateMergeGate(
  tx: TxClient,
  params: EvaluateMergeGateParams,
): Promise<MergeGateEvaluationResult> {
  const { featureRunId, projectId, featureRequestId } = params;
  const reasons: string[] = [];

  const pr = await getPullRequestByFeatureRun(tx, featureRunId);
  const ciStatus = pr?.ci_status ?? null;
  const reviewStatus = pr?.review_state ?? null;

  if (!pr) {
    reasons.push('no pull request is tracked for this feature run yet');
  } else {
    if (ciStatus !== 'passed') {
      reasons.push(`CI status is '${ciStatus}', not 'passed'`);
    }
    if (reviewStatus === 'changes_requested') {
      reasons.push('GitHub reports outstanding review changes-requested');
    }
  }

  const findingRows = await tx.query<UnresolvedFindingsRow>(
    `SELECT COUNT(*) as count FROM review_findings
     WHERE feature_run_id = ? AND resolved = FALSE
       AND severity IN (?, ?)`,
    [featureRunId, FindingSeverity.BLOCKING, FindingSeverity.REQUIRES_HUMAN_DECISION],
  );
  const unresolvedBlockingFindings = Number(findingRows[0]?.count ?? 0);
  if (unresolvedBlockingFindings > 0) {
    reasons.push(
      `${unresolvedBlockingFindings} unresolved blocking/requires-human-decision finding(s)`,
    );
  }

  const blockingLabelsPolicy = resolveBlockingLabelsPolicy();
  let matchedBlockingLabels: string[] = [];
  if (pr && blockingLabelsPolicy.length > 0) {
    const observedLabels = parseJsonField<string[]>(pr.blocking_labels ?? '[]');
    const observedLower = new Set(observedLabels.map((l) => l.toLowerCase()));
    matchedBlockingLabels = blockingLabelsPolicy.filter((label) => observedLower.has(label));
    if (matchedBlockingLabels.length > 0) {
      reasons.push(`blocking label(s) present: ${matchedBlockingLabels.join(', ')}`);
    }
  }

  const branchProtectionOk = pr ? Boolean(pr.mergeable) : false;
  if (!branchProtectionOk) {
    reasons.push(
      'pull request is not currently mergeable (branch protection / mergeability check)',
    );
  }

  const budgetEvaluation = await evaluateBudget(tx, {
    projectId,
    featureRequestId,
    scope: BudgetScope.FEATURE,
  });
  const budgetStatus = budgetEvaluation?.status ?? 'ok';
  if (budgetStatus !== 'ok') {
    reasons.push(`feature budget status is '${budgetStatus}'`);
  }

  // "Required human approvals exist" (docs/01 §12): upstream approvals recorded in
  // human_approvals (e.g. assumption acceptance, budget override) must not have been rejected or
  // left deferred — the merge-if-ready invocation itself is not one of these approvals.
  const outstandingApprovalRows = await tx.query<OutstandingHumanApprovalRow>(
    `SELECT id, decision FROM human_approvals
     WHERE feature_run_id = ? AND decision IN ('rejected', 'deferred')
     ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [featureRunId],
  );
  const outstandingApproval = outstandingApprovalRows[0];
  const humanApprovalRequired = Boolean(outstandingApproval);
  const humanApprovalId = outstandingApproval?.id ?? null;
  if (outstandingApproval) {
    reasons.push(`a required human approval is '${outstandingApproval.decision}', not 'approved'`);
  }

  const decision: MergeGateDecision = reasons.length === 0 ? 'approved' : 'rejected';

  const evaluationId = generateId();
  const now = isoNow();
  await tx.execute(
    `INSERT INTO merge_gate_evaluations
       (id, feature_run_id, ci_status, review_status, unresolved_blocking_findings, budget_status,
        human_approval_required, human_approval_id, branch_protection_ok, final_decision,
        evaluated_at, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      evaluationId,
      featureRunId,
      ciStatus,
      reviewStatus,
      unresolvedBlockingFindings,
      budgetStatus,
      // The SQLite driver rejects JS booleans as bound parameters (only numbers, strings,
      // bigints, buffers, and null are accepted); the PostgreSQL driver accepts them, but 0/1
      // integers work identically against a PostgreSQL BOOLEAN column when bound (not inlined as
      // a SQL literal — see CLAUDE.md's round-4 merge-failed fix for that distinction), so this
      // is the one representation that works across both dialects as a bound parameter.
      humanApprovalRequired ? 1 : 0,
      humanApprovalId,
      branchProtectionOk ? 1 : 0,
      decision,
      now,
      now,
      now,
    ],
  );

  return {
    evaluationId,
    decision,
    reasons,
    ciStatus,
    reviewStatus,
    unresolvedBlockingFindings,
    budgetStatus,
    humanApprovalRequired,
    humanApprovalId,
    branchProtectionOk,
  };
}
