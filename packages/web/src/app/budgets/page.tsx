import type { ReactElement } from 'react';
import { getApiClient } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { StatusBadge } from '../../components/status-badge';
import { Table } from '../../components/table';
import { OverrideForm } from './override-form';

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<ReactElement> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  const [projects, budgets, status] = await Promise.all([
    client.listProjects({ limit: '100' }),
    client.listBudgetPolicies(projectId, { limit: '50' }),
    client.getStatus(projectId),
  ]);
  const workflowVersion = status.workflowState?.version;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Budgets</h1>
        <ProjectSwitcher projects={projects.items} currentProjectId={projectId} />
      </div>

      {status.workflowState?.automation_state === 'paused_budget_exceeded' ||
      status.workflowState?.automation_state === 'waiting_for_budget_approval' ? (
        <p style={{ color: '#b45309' }}>
          Automation is currently <StatusBadge value={status.workflowState.automation_state} /> — a
          budget threshold was breached.
        </p>
      ) : null}

      <Table
        rows={budgets.items}
        rowKey={(row) => row.id}
        columns={[
          { key: 'scope', header: 'Scope', render: (row) => row.scope },
          { key: 'soft', header: 'Soft limit', render: (row) => row.soft_limit ?? '—' },
          { key: 'hard', header: 'Hard limit', render: (row) => row.hard_limit ?? '—' },
          { key: 'currency', header: 'Currency', render: (row) => row.currency },
          { key: 'active', header: 'Active', render: (row) => (row.is_active ? 'yes' : 'no') },
          {
            key: 'override',
            header: 'Override',
            render: (row) =>
              workflowVersion !== undefined ? (
                <OverrideForm
                  projectId={projectId}
                  workflowVersion={workflowVersion}
                  budgetPolicyId={row.id}
                />
              ) : (
                '—'
              ),
          },
        ]}
      />
    </div>
  );
}
