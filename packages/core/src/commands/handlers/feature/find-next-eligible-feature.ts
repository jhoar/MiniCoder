import type { DbClient } from '../../../persistence/types.js';

interface EligibleFeatureRunRow {
  id: string;
  version: number;
}

/**
 * Read-only candidate picker for the next eligible feature run in a project: at
 * approved_pending_execution, with every feature_dependencies target already merged, ordered
 * deterministically by feature_requests.created_at/id for a stable "in sequence" pick.
 *
 * This is not a state-transition authority — SelectFeatureHandler re-checks the dependency
 * guard itself and remains the sole source of truth for the approved_pending_execution ->
 * selected transition. A stale candidate returned here (e.g. a dependency that merges between
 * this read and the SelectFeatureCommand dispatch) is simply rejected by that handler.
 */
export async function findNextEligibleFeatureRun(
  db: DbClient,
  projectId: string,
): Promise<{ id: string; version: number } | null> {
  const rows = await db.query<EligibleFeatureRunRow>(
    `SELECT fr.id, fr.version
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE freq.project_id = ?
       AND fr.current_execution_state = 'approved_pending_execution'
       AND NOT EXISTS (
         SELECT 1 FROM feature_dependencies fd
         WHERE fd.source_fr_id = freq.id
           AND NOT EXISTS (
             SELECT 1 FROM feature_runs fr2
             WHERE fr2.feature_request_id = fd.target_fr_id
               AND fr2.current_execution_state = 'merged'
           )
       )
     ORDER BY freq.created_at ASC, freq.id ASC
     LIMIT 1`,
    [projectId],
  );
  return rows[0] ?? null;
}
