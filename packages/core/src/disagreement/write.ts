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

/** Marks a disagreement as resolved by a human disposition (`ResolveDisagreementHandler`), as
 * distinct from an Arbiter disposition (`recordArbiterDisposition` above) — kept as a separate,
 * narrower function so a human resolution can never accidentally attribute itself to an
 * `agent_runs` row. Matches `open` or `escalated` — a human can resolve a disagreement the
 * Arbiter never got to as readily as one it already escalated. */
export async function resolveDisagreementByHuman(
  tx: TxClient,
  opts: { disagreementId: string; resolution: string },
): Promise<void> {
  const now = isoNow();
  await tx.execute(
    `UPDATE disagreement_records
     SET state = ?, resolution = ?, resolved_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND state IN (?, ?)`,
    [
      DisagreementState.RESOLVED,
      opts.resolution,
      now,
      now,
      opts.disagreementId,
      DisagreementState.OPEN,
      DisagreementState.ESCALATED,
    ],
  );
}

export function disagreementRecordId(featureRunId: string, reviewCycle: number): string {
  return `disagreement:${featureRunId}:${reviewCycle}`;
}
