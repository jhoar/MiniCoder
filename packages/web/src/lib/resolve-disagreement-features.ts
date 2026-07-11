import type { DisagreementRow } from '@minicoder/api';
import type { ApiClient } from './api-client';

export interface DisagreementWithFeature extends DisagreementRow {
  featureRequestId: string;
  featureProjectId: string;
}

/** `/features/[id]` expects a feature *request* ID, not a feature *run* ID (`feature_run_id`) —
 * these are distinct identifiers (a feature request can have multiple runs across retries), and
 * a disagreement's owning feature can belong to a *different* project than whichever one is
 * currently selected in this page's `?project=` param. Resolving through the run (for the request
 * ID) and the feature request (for its real project ID) fixes both a broken navigation link and a
 * cross-project link-context bug caught in PR review — see CLAUDE.md's Next.js Web UI Operational
 * Constraints for the general pattern. Lives in `lib/` (not inline in `disagreements/page.tsx`)
 * specifically so it stays importable from a plain Vitest unit test — this file has no
 * `server-only` import, unlike `api-server.ts`. */
export async function resolveDisagreementFeatures(
  client: ApiClient,
  disagreements: DisagreementRow[],
): Promise<DisagreementWithFeature[]> {
  return Promise.all(
    disagreements.map(async (d) => {
      const run = await client.getFeatureRun(d.feature_run_id);
      const { feature } = await client.getFeature(run.feature_request_id);
      return { ...d, featureRequestId: feature.id, featureProjectId: feature.project_id };
    }),
  );
}
