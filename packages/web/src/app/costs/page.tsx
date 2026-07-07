import { getApiClient } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { Table } from '../../components/table';

export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<JSX.Element> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  const [projects, costs] = await Promise.all([
    client.listProjects({ limit: '100' }),
    client.listCostRecords(projectId, { limit: '100' }),
  ]);

  const total = costs.items.reduce((sum, row) => sum + row.amount, 0);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Costs</h1>
        <ProjectSwitcher projects={projects.items} currentProjectId={projectId} />
      </div>
      <p>
        Total (this page, {costs.items[0]?.currency ?? 'USD'}): <strong>{total.toFixed(4)}</strong>
      </p>
      <Table
        rows={costs.items}
        rowKey={(row) => row.id}
        columns={[
          { key: 'scope', header: 'Scope', render: (row) => row.scope },
          { key: 'amount', header: 'Amount', render: (row) => `${row.amount} ${row.currency}` },
          { key: 'provider', header: 'Provider', render: (row) => row.provider ?? '—' },
          { key: 'model', header: 'Model', render: (row) => row.model ?? '—' },
          { key: 'feature', header: 'Feature run', render: (row) => row.feature_run_id ?? '—' },
          { key: 'recorded', header: 'Recorded at', render: (row) => row.recorded_at },
        ]}
      />
    </div>
  );
}
