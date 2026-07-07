import type { ReactElement } from 'react';
import { getApiClient } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { StatusBadge } from '../../components/status-badge';
import { Table } from '../../components/table';
import type { ReviewFindingRow } from '@minicoder/api';

/** `GET /review-findings` requires `featureRunId` (findings are always scoped to one feature
 * run) — there is no project-wide findings endpoint. This page fans out across every feature's
 * runs to build a project-wide view; acceptable given this repo's expected per-project feature
 * volume (mirrors the same "fetch and aggregate, no new API filter" call the pull-request-by-
 * number lookup already makes — see `lib/api-server.ts`). */
async function collectProjectFindings(
  client: ReturnType<typeof getApiClient>,
  projectId: string,
): Promise<Array<ReviewFindingRow & { featureFrId: string }>> {
  const features = await client.listFeatures(projectId, { limit: '50' });
  const results: Array<ReviewFindingRow & { featureFrId: string }> = [];
  for (const feature of features.items) {
    const { runs } = await client.getFeature(feature.id);
    for (const run of runs.slice(0, 3)) {
      const findings = await client.listReviewFindings(run.id, { limit: '20' });
      for (const finding of findings.items) {
        results.push({ ...finding, featureFrId: feature.fr_id });
      }
    }
  }
  return results;
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
      <Table
        rows={findings}
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
