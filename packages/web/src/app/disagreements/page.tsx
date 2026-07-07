import type { ReactElement } from 'react';
import { getApiClient } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { StatusBadge } from '../../components/status-badge';
import { Table } from '../../components/table';

export default async function DisagreementsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<ReactElement> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  // `/disagreements` has no project-scoping filter (see packages/api/src/read-models/governance.ts)
  // — this lists every open/escalated disagreement across the whole deployment, which is the best
  // this API surface supports today. Resolution happens from the linked feature's detail page,
  // where the feature run's current version is already known.
  const [projects, disagreements, policyDecisions] = await Promise.all([
    client.listProjects({ limit: '100' }),
    client.listDisagreements({}, { limit: '50' }),
    client.listPolicyDecisions(projectId, { limit: '50' }),
  ]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Disagreements</h1>
        <ProjectSwitcher projects={projects.items} currentProjectId={projectId} />
      </div>

      <section>
        <h2>Disagreements (all projects)</h2>
        <Table
          rows={disagreements.items}
          rowKey={(row) => row.id}
          columns={[
            { key: 'state', header: 'State', render: (row) => <StatusBadge value={row.state} /> },
            {
              key: 'feature',
              header: 'Feature run',
              render: (row) => (
                <a href={`/features/${row.feature_run_id}?project=${projectId}`}>
                  {row.feature_run_id}
                </a>
              ),
            },
            { key: 'cycle', header: 'Review cycle', render: (row) => row.review_cycle },
            { key: 'resolution', header: 'Resolution', render: (row) => row.resolution ?? '—' },
          ]}
        />
      </section>

      <section>
        <h2>Policy decisions (this project)</h2>
        <Table
          rows={policyDecisions.items}
          rowKey={(row) => row.id}
          columns={[
            { key: 'type', header: 'Policy type', render: (row) => row.policy_type },
            {
              key: 'decision',
              header: 'Decision',
              render: (row) => <StatusBadge value={row.decision} />,
            },
            { key: 'actor', header: 'Actor', render: (row) => row.actor ?? '—' },
            { key: 'decided', header: 'Decided at', render: (row) => row.decided_at },
          ]}
        />
      </section>
    </div>
  );
}
