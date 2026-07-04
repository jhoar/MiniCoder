import { isoNow } from '../commands/helpers.js';
import { DisagreementState } from '../domain/states.js';
import type { DbClient, TxClient } from '../persistence/types.js';

/**
 * Evidence-data writer for `disagreement_records` — not a `CommandHandler` (mirrors
 * `insertReviewFindings()`'s non-command posture). Deterministic id
 * (`disagreement:{featureRunId}:{reviewCycle}`) plus `ON CONFLICT (id) DO NOTHING` makes a retried
 * `run-review` invocation that already opened a disagreement for this cycle a no-op rather than a
 * duplicate row.
 */
export async function insertDisagreementRecord(
  db: DbClient | TxClient,
  opts: {
    featureRunId: string;
    findingId: string | null;
    reviewCycle: number;
  },
): Promise<string> {
  const id = `disagreement:${opts.featureRunId}:${opts.reviewCycle}`;
  const now = isoNow();
  await db.execute(
    `INSERT INTO disagreement_records
       (id, feature_run_id, finding_id, review_cycle, state, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    [id, opts.featureRunId, opts.findingId, opts.reviewCycle, DisagreementState.OPEN, now, now],
  );
  return id;
}

/** Records the Arbiter's disposition for a disagreement — called from `run-review.ts` right after
 * invoking `ArbiterAgentAdapter`, before deciding whether to escalate or continue the fix loop. */
export async function recordArbiterDisposition(
  db: DbClient | TxClient,
  opts: {
    disagreementId: string;
    arbiterRunId: string;
    state: typeof DisagreementState.RESOLVED | typeof DisagreementState.ESCALATED;
    resolution: string;
  },
): Promise<void> {
  const now = isoNow();
  await db.execute(
    `UPDATE disagreement_records
     SET state = ?, arbiter_run_id = ?, resolution = ?, resolved_at = ?, version = version + 1, updated_at = ?
     WHERE id = ?`,
    [opts.state, opts.arbiterRunId, opts.resolution, now, now, opts.disagreementId],
  );
}

export interface DisagreementRecordRow {
  id: string;
  feature_run_id: string;
  finding_id: string | null;
  review_cycle: number;
  state: string;
  arbiter_run_id: string | null;
  resolution: string | null;
}

/** The most recent still-unresolved disagreement for a feature run (`open` — never arbitrated, or
 * `escalated` — the Arbiter pushed it to a human but a human hasn't dispositioned it yet) — used
 * by the human-resolution CLI/handlers to find the disagreement a `ResolveDisagreementCommand`
 * should act on when the caller doesn't already know the disagreement id. */
export async function findOpenDisagreement(
  db: DbClient | TxClient,
  featureRunId: string,
): Promise<DisagreementRecordRow | null> {
  const rows = await db.query<DisagreementRecordRow>(
    `SELECT id, feature_run_id, finding_id, review_cycle, state, arbiter_run_id, resolution
     FROM disagreement_records
     WHERE feature_run_id = ? AND state IN (?, ?)
     ORDER BY review_cycle DESC LIMIT 1`,
    [featureRunId, DisagreementState.OPEN, DisagreementState.ESCALATED],
  );
  return rows[0] ?? null;
}

/**
 * Resolves and validates the disagreement a human-disposition command should act on, scoped to
 * `featureRunId` in both cases — a caller-supplied `disagreementId` is never trusted bare. If the
 * caller already knows the id (e.g. a CLI `--disagreement` flag), the row is looked up by
 * `id + feature_run_id + state IN (open, escalated)`, so an id for a different feature run or an
 * already-resolved disagreement resolves to `null` here rather than being passed on to
 * `resolveDisagreementByHuman()` unchecked. If no id is supplied, falls back to the same
 * "most recent still-open" lookup `findOpenDisagreement()` performs.
 */
export async function findDisagreementForFeatureRun(
  db: DbClient | TxClient,
  opts: { featureRunId: string; disagreementId?: string },
): Promise<DisagreementRecordRow | null> {
  if (!opts.disagreementId) {
    return findOpenDisagreement(db, opts.featureRunId);
  }
  const rows = await db.query<DisagreementRecordRow>(
    `SELECT id, feature_run_id, finding_id, review_cycle, state, arbiter_run_id, resolution
     FROM disagreement_records
     WHERE id = ? AND feature_run_id = ? AND state IN (?, ?)`,
    [opts.disagreementId, opts.featureRunId, DisagreementState.OPEN, DisagreementState.ESCALATED],
  );
  return rows[0] ?? null;
}

/**
 * Marks a disagreement as resolved by a human disposition (`ResolveDisagreementHandler`/
 * `ResumeFeatureExecutionHandler`), as distinct from an Arbiter disposition
 * (`recordArbiterDisposition` above) — kept as a separate, narrower function so a human
 * resolution can never accidentally attribute itself to an `agent_runs` row. Scoped to
 * `featureRunId` (not just `id`) as defense-in-depth against a caller that skipped
 * `findDisagreementForFeatureRun()`'s validation, and returns the affected-row count so callers
 * can detect and reject a no-op update instead of proceeding as if the resolution succeeded — a
 * real bug in the initial Phase 11 cut: both handlers called this unconditionally on a
 * caller-supplied id with no existence/ownership check, so a bogus or cross-feature id silently
 * updated 0 rows (or someone else's disagreement) while the feature run's state transition
 * proceeded anyway.
 */
export async function resolveDisagreementByHuman(
  tx: TxClient,
  opts: { disagreementId: string; featureRunId: string; resolution: string },
): Promise<number> {
  const now = isoNow();
  return tx.executeAffected(
    `UPDATE disagreement_records
     SET state = ?, resolution = ?, resolved_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND feature_run_id = ? AND state IN (?, ?)`,
    [
      DisagreementState.RESOLVED,
      opts.resolution,
      now,
      now,
      opts.disagreementId,
      opts.featureRunId,
      DisagreementState.OPEN,
      DisagreementState.ESCALATED,
    ],
  );
}

export function disagreementRecordId(featureRunId: string, reviewCycle: number): string {
  return `disagreement:${featureRunId}:${reviewCycle}`;
}
