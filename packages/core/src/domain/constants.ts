/**
 * Cross-cutting numeric/domain constants that don't belong to any single state enum.
 *
 * `FIX_ATTEMPT_THRESHOLD` (Phase 10 — Review/Fix Loop): the single feature-level
 * `feature_runs.fix_attempt_count` counter is checked against this constant everywhere the
 * feature-execution matrix calls for a "fix-attempt count < per-feature threshold" guard
 * (`ci_failed -> changes_requested`/`ci_failed -> human_required`, `under_review ->
 * changes_requested`/`under_review -> human_required`). This is a deliberate simplification: the
 * canonical docs/01 §5.8 limits ("five review cycles per feature, two fix attempts per finding,
 * one reopening of the same finding") describe finer per-finding/reopening granularity that this
 * phase does not implement — only the single aggregate per-feature counter. Finer-grained
 * tracking is deferred, not designed away; see CLAUDE.md's Reference Reviewer Adapter and
 * Review/Fix Loop Operational Constraints for the full rationale.
 */
export const FIX_ATTEMPT_THRESHOLD = 5;
