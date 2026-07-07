import { getApiClient } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { StatusBadge } from '../../components/status-badge';
import { Table } from '../../components/table';

export default async function FeaturesPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<JSX.Element> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  const [projects, features] = await Promise.all([
    client.listProjects({ limit: '100' }),
    client.listFeatures(projectId, { limit: '100' }),
  ]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Features</h1>
        <ProjectSwitcher projects={projects.items} currentProjectId={projectId} />
      </div>
      <Table
        rows={features.items}
        rowKey={(row) => row.id}
        columns={[
          {
            key: 'fr',
            header: 'ID',
            render: (row) => <a href={`/features/${row.id}?project=${projectId}`}>{row.fr_id}</a>,
          },
          { key: 'title', header: 'Title', render: (row) => row.title },
          { key: 'kind', header: 'Kind', render: (row) => row.kind },
          { key: 'state', header: 'State', render: (row) => <StatusBadge value={row.state} /> },
          { key: 'priority', header: 'Priority', render: (row) => row.priority },
        ]}
      />
    </div>
  );
}
