import type { ReactElement } from 'react';
import { getApiClient } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { StatusBadge } from '../../components/status-badge';
import { Table } from '../../components/table';
import type { ReviewFindingRow } from '@minicoder/api';

interface ProjectFindings {
  items: Array<ReviewFindingRow & { featureFrId: string }>;
  /** True if any per-feature/per-run/per-finding cap below was actually hit — i.e. this is a
   * sample, not the complete set. Surfaced in the UI rather than silently capped (caught in PR
   * review): an operator dashboard must not present a truncated view as if it were complete. */
  truncated: boolean;
}

/** `GET /review-findings` requires `featureRunId` (findings are always scoped to one feature
 * run) — there is no project-wide findings endpoint. This page fans out across every feature's
 * runs to build a project-wide view; acceptable given this repo's expected per-project feature
 * volume (mirrors the same "fetch and aggregate, no new API filter" call the pull-request-by-
 * number lookup already makes — see `lib/api-server.ts`). The per-feature (50), per-run (3), and
 * per-finding (20) caps below are a sampled view, not a guarantee of completeness — see
 * `truncated` above. */
async function collectProjectFindings(
  client: ReturnType<typeof getApiClient>,
  projectId: string,
): Promise<ProjectFindings> {
  const FEATURE_LIMIT = 50;
  const RUNS_PER_FEATURE = 3;
  const FINDINGS_PER_RUN = 20;

  const features = await client.listFeatures(projectId, { limit: String(FEATURE_LIMIT) });
  let truncated = features.items.length >= FEATURE_LIMIT || Boolean(features.nextCursor);
  const results: Array<ReviewFindingRow & { featureFrId: string }> = [];
  for (const feature of features.items) {
    const { runs } = await client.getFeature(feature.id);
    if (runs.length > RUNS_PER_FEATURE) truncated = true;
    for (const run of runs.slice(0, RUNS_PER_FEATURE)) {
      const findings = await client.listReviewFindings(run.id, { limit: String(FINDINGS_PER_RUN) });
      if (findings.items.length >= FINDINGS_PER_RUN || findings.nextCursor) truncated = true;
      for (const finding of findings.items) {
        results.push({ ...finding, featureFrId: feature.fr_id });
      }
    }
  }
  return { items: results, truncated };
}

export default async function FindingsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<ReactElement> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  const [projects, findings] = await Promise.all([
    client.listProjects({ limit: '100' }),
    collectProjectFindings(client, projectId),
  ]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Review Findings</h1>
        <ProjectSwitcher projects={projects.items} currentProjectId={projectId} />
      </div>
      {findings.truncated && (
        <p style={{ color: '#b45309' }}>
          This view is sampled (capped per feature/run/finding) and may not show every finding — see
          individual feature pages for a complete list.
        </p>
      )}
      <Table
        rows={findings.items}
        rowKey={(row) => row.id}
        columns={[
          { key: 'feature', header: 'Feature', render: (row) => row.featureFrId },
          {
            key: 'severity',
            header: 'Severity',
            render: (row) => <StatusBadge value={row.severity} />,
          },
          { key: 'description', header: 'Description', render: (row) => row.description },
          { key: 'cycle', header: 'Review cycle', render: (row) => row.review_cycle },
          { key: 'resolved', header: 'Resolved', render: (row) => (row.resolved ? 'yes' : 'no') },
        ]}
      />
    </div>
  );
}
