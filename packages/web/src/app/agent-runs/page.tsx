import { getApiClient } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { StatusBadge } from '../../components/status-badge';
import { Table } from '../../components/table';

export default async function AgentRunsPage({
  searchParams,
}: {
  searchParams: { project?: string };
}): Promise<JSX.Element> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  const [projects, agentRuns, adapters, configurations] = await Promise.all([
    client.listProjects({ limit: '100' }),
    client.listAgentRuns({ projectId }, { limit: '50' }),
    client.listAgentAdapters({ limit: '50' }),
    client.listAgentConfigurations(undefined, { limit: '50' }),
  ]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Agent Runs</h1>
        <ProjectSwitcher projects={projects.items} currentProjectId={projectId} />
      </div>

      <section>
        <h2>Runs</h2>
        <Table
          rows={agentRuns.items}
          rowKey={(row) => row.id}
          columns={[
            { key: 'role', header: 'Role', render: (row) => row.role },
            { key: 'state', header: 'State', render: (row) => <StatusBadge value={row.state} /> },
            { key: 'feature', header: 'Feature run', render: (row) => row.feature_run_id ?? '—' },
            { key: 'tokens', header: 'Tokens', render: (row) => row.tokens_used ?? '—' },
            { key: 'cost', header: 'Cost (USD)', render: (row) => row.cost_usd ?? '—' },
          ]}
        />
      </section>

      <section>
        <h2>Registered adapters</h2>
        <Table
          rows={adapters.items}
          rowKey={(row) => row.id}
          columns={[
            { key: 'role', header: 'Role', render: (row) => row.role },
            { key: 'name', header: 'Name', render: (row) => row.name },
            { key: 'impl', header: 'Implementation', render: (row) => row.implementation },
            { key: 'active', header: 'Active', render: (row) => (row.is_active ? 'yes' : 'no') },
          ]}
        />
      </section>

      <section>
        <h2>Adapter configurations</h2>
        <Table
          rows={configurations.items}
          rowKey={(row) => row.id}
          columns={[
            { key: 'adapter', header: 'Adapter', render: (row) => row.adapter_id },
            {
              key: 'project',
              header: 'Project scope',
              render: (row) => row.project_id ?? 'default',
            },
            { key: 'version', header: 'Version', render: (row) => row.version },
          ]}
        />
      </section>
    </div>
  );
}
