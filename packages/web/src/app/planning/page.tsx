import type { ReactElement } from 'react';
import { getApiClient } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { StatusBadge } from '../../components/status-badge';
import { Table } from '../../components/table';
import { PlanRowActions } from './plan-row-actions';

export default async function PlanningPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<ReactElement> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  const [projects, plans, readiness] = await Promise.all([
    client.listProjects({ limit: '100' }),
    client.listImplementationPlans(projectId, { limit: '50' }),
    client.listPlanningReadinessAssessments(projectId, { limit: '10' }),
  ]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Planning</h1>
        <ProjectSwitcher projects={projects.items} currentProjectId={projectId} />
      </div>

      <section>
        <h2>Implementation plans</h2>
        <Table
          rows={plans.items}
          rowKey={(row) => row.id}
          columns={[
            { key: 'id', header: 'Plan', render: (row) => row.id },
            { key: 'state', header: 'State', render: (row) => <StatusBadge value={row.state} /> },
            { key: 'version', header: 'Version', render: (row) => row.version },
            {
              key: 'actions',
              header: 'Actions',
              render: (row) => (
                <PlanRowActions
                  planId={row.id}
                  projectId={projectId}
                  state={row.state}
                  version={row.version}
                />
              ),
            },
          ]}
        />
      </section>

      <section>
        <h2>Planning readiness assessments</h2>
        <Table
          rows={readiness.items}
          rowKey={(row) => row.id}
          columns={[
            { key: 'id', header: 'Assessment', render: (row) => row.id },
            {
              key: 'status',
              header: 'Status',
              render: (row) => <StatusBadge value={row.status} />,
            },
            { key: 'created', header: 'Created', render: (row) => row.created_at },
          ]}
        />
      </section>
    </div>
  );
}
