/**
 * Issue #116: the only mechanism anywhere in this codebase that ever marks a `review_findings`
 * row `resolved` is `RecordCodePushedHandler`'s fix-cycle "optimistic fixed" write, which only
 * runs on a `fixing -> code_pushed` push — i.e. only when a `blocking` finding already triggered
 * a fix cycle. A review producing only `non_blocking`/`nit`/`question`/`out_of_scope` findings
 * never enters a fix cycle at all, so those findings are written once and then permanently
 * orphaned: never resolvable by any command, indistinguishable from "nobody ever looked at this."
 *
 * `resolveReviewFinding()` is a lightweight human-disposition action for exactly this case — not
 * a `CommandHandler`, since `review_findings` is not governed by a `StateTransitionValidator`
 * matrix (`resolved` is a plain boolean column, no `CHECK` constraint). It reuses
 * `human_approvals` (via `insertHumanApproval()`) for the disposition audit trail rather than
 * inventing new columns: `--dismiss` records `decision: 'approved'` ("looked at, not worth
 * fixing") and also flips `review_findings.resolved` to `TRUE`; omitting it records
 * `decision: 'deferred'` ("looked at, still wants it addressed") and leaves `resolved` at its
 * current value — so a caller can distinguish "never looked at" (no `human_approvals` row for
 * this finding), "looked at, still open" (`deferred`, `resolved = FALSE`), and "looked at,
 * dismissed" (`approved`, `resolved = TRUE`) instead of only ever seeing `resolved = FALSE` for
 * the first two indistinguishably.
 */
import { generateId, insertHumanApproval, type DbClient } from '@minicoder/core';
import { NotFoundError } from '../errors.js';

export interface ResolveReviewFindingResult {
  findingId: string;
  dismissed: boolean;
  alreadyResolved: boolean;
}

interface ReviewFindingRow {
  id: string;
  feature_run_id: string;
  resolved: number | boolean;
  project_id: string;
}

function isoNow(): string {
  return new Date().toISOString();
}

export async function resolveReviewFinding(
  db: DbClient,
  opts: {
    findingId: string;
    dismiss: boolean;
    note?: string;
    actorId: string;
    actorRole: string;
  },
): Promise<ResolveReviewFindingResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<ReviewFindingRow>(
      `SELECT rf.id, rf.feature_run_id, rf.resolved, freq.project_id
       FROM review_findings rf
       JOIN feature_runs fr ON fr.id = rf.feature_run_id
       JOIN feature_requests freq ON freq.id = fr.feature_request_id
       WHERE rf.id = ?`,
      [opts.findingId],
    );
    const finding = rows[0];
    if (!finding) throw new NotFoundError('review_findings', opts.findingId);

    const alreadyResolved = Boolean(finding.resolved);
    const now = isoNow();

    await insertHumanApproval(tx, {
      projectId: finding.project_id,
      featureRunId: finding.feature_run_id,
      contextType: 'review_finding_disposition',
      contextId: finding.id,
      decision: opts.dismiss ? 'approved' : 'deferred',
      actor: opts.actorId,
      actorRole: opts.actorRole,
      notes: opts.note,
    });

    if (opts.dismiss && !alreadyResolved) {
      await tx.execute(
        `UPDATE review_findings SET resolved = TRUE, version = version + 1, updated_at = ? WHERE id = ?`,
        [now, finding.id],
      );
    }

    await tx.execute(
      `INSERT INTO workflow_events (id, feature_run_id, project_id, event_type, from_state, to_state, actor, payload, payload_schema_version, occurred_at, created_at)
       VALUES (?, ?, ?, 'review_finding.disposition_recorded', NULL, NULL, ?, ?, '1.0', ?, ?)`,
      [
        generateId(),
        finding.feature_run_id,
        finding.project_id,
        opts.actorId,
        JSON.stringify({ findingId: finding.id, dismiss: opts.dismiss, note: opts.note ?? null }),
        now,
        now,
      ],
    );

    return { findingId: finding.id, dismissed: opts.dismiss, alreadyResolved };
  });
}
