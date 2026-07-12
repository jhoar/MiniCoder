import type { ReactElement } from 'react';
import type { BudgetBreakdownRow } from '@minicoder/api';
import { getApiClient } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { KeyValue } from '../../components/key-value';
import { Table } from '../../components/table';

function BreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: BudgetBreakdownRow[];
}): ReactElement {
  return (
    <div>
      <h3 style={{ marginBottom: '4px' }}>{title}</h3>
      <Table
        rows={rows}
        rowKey={(row) => row.key}
        columns={[
          { key: 'key', header: title, render: (row) => row.key },
          {
            key: 'total',
            header: 'Total',
            render: (row) => row.totalAmount.toFixed(4),
          },
          { key: 'count', header: 'Records', render: (row) => row.recordCount },
        ]}
      />
    </div>
  );
}

export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; windowDays?: string }>;
}): Promise<ReactElement> {
  const client = getApiClient();
  const params = await searchParams;
  const projectId = await resolveProjectId(searchParams);
  const windowDays = params.windowDays ? Number(params.windowDays) : undefined;
  const [projects, costs, report] = await Promise.all([
    client.listProjects({ limit: '100' }),
    client.listCostRecords(projectId, { limit: '100' }),
    client.getBudgetReport(
      projectId,
      windowDays !== undefined && Number.isFinite(windowDays) ? windowDays : undefined,
    ),
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

      <section style={{ marginTop: '32px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2>Budget report</h2>
          <form method="get" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input type="hidden" name="project" value={projectId} />
            <label htmlFor="windowDays" style={{ fontSize: '0.85rem', color: '#64748b' }}>
              Window (days)
            </label>
            <input
              id="windowDays"
              name="windowDays"
              type="number"
              min={1}
              defaultValue={params.windowDays ?? ''}
              placeholder="all time"
              style={{ width: '90px' }}
            />
            <button type="submit">Apply</button>
          </form>
        </div>
        <KeyValue
          entries={[
            {
              label: 'Window',
              value: report.windowDays ? `${report.windowDays} days` : 'all time',
            },
            {
              label: 'Total spend',
              value: `${report.totalAmount.toFixed(4)} (${report.recordCount} records)`,
            },
          ]}
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '16px',
            marginTop: '12px',
          }}
        >
          <BreakdownTable title="By scope" rows={report.byScope} />
          <BreakdownTable title="By feature" rows={report.byFeature} />
          <BreakdownTable title="By provider" rows={report.byProvider} />
          <BreakdownTable title="By model" rows={report.byModel} />
          <BreakdownTable title="By role" rows={report.byRole} />
        </div>
      </section>
    </div>
  );
}
