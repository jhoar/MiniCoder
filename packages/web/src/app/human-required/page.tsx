import type { ReactElement } from 'react';
import { getApiClient } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { StatusBadge } from '../../components/status-badge';
import { Table } from '../../components/table';

export default async function HumanRequiredPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<ReactElement> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  const [projects, items] = await Promise.all([
    client.listProjects({ limit: '100' }),
    client.listHumanRequiredItems(projectId, { limit: '50' }),
  ]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Human Required</h1>
        <ProjectSwitcher projects={projects.items} currentProjectId={projectId} />
      </div>
      <Table
        rows={items.items}
        rowKey={(row) => row.feature_run_id}
        emptyLabel="Nothing requires human attention right now."
        columns={[
          { key: 'fr', header: 'Feature', render: (row) => row.fr_id },
          { key: 'title', header: 'Title', render: (row) => row.title },
          {
            key: 'state',
            header: 'Execution state',
            render: (row) => <StatusBadge value={row.current_execution_state} />,
          },
          {
            key: 'actions',
            header: 'Actions',
            render: (row) => (
              <a href={`/features/${row.feature_request_id}?project=${projectId}`}>
                Open feature →
              </a>
            ),
          },
        ]}
      />
    </div>
  );
}
