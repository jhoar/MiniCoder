import { getApiClient } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { KeyValue } from '../../components/key-value';
import { StatusBadge } from '../../components/status-badge';
import { Table } from '../../components/table';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { project?: string };
}): Promise<JSX.Element> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  const [projects, status, activeFeature, humanRequired, triggerdevRuns] = await Promise.all([
    client.listProjects({ limit: '100' }),
    client.getStatus(projectId),
    client.getActiveFeature(projectId),
    client.listHumanRequiredItems(projectId, { limit: '5' }),
    client.listTriggerdevRuns({ projectId }, { limit: '10' }),
  ]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Dashboard</h1>
        <ProjectSwitcher projects={projects.items} currentProjectId={projectId} />
      </div>

      <section>
        <h2>Project status</h2>
        <KeyValue
          entries={[
            { label: 'Project', value: status.project?.name ?? '—' },
            {
              label: 'Project state',
              value: status.project ? <StatusBadge value={status.project.state} /> : '—',
            },
            {
              label: 'Automation state',
              value: status.workflowState ? (
                <StatusBadge value={status.workflowState.automation_state} />
              ) : (
                '—'
              ),
            },
            { label: 'Pending outbox events', value: status.pendingOutboxCount },
          ]}
        />
      </section>

      <section>
        <h2>Active feature</h2>
        {activeFeature.activeFeatureRun ? (
          <KeyValue
            entries={[
              { label: 'Feature run', value: activeFeature.activeFeatureRun.id },
              {
                label: 'Execution state',
                value: (
                  <StatusBadge value={activeFeature.activeFeatureRun.current_execution_state} />
                ),
              },
            ]}
          />
        ) : (
          <p style={{ color: '#64748b' }}>No feature is currently active.</p>
        )}
      </section>

      <section>
        <h2>Human required (top 5)</h2>
        <Table
          rows={humanRequired.items}
          rowKey={(row) => row.feature_run_id}
          columns={[
            { key: 'fr', header: 'Feature', render: (row) => row.fr_id },
            { key: 'title', header: 'Title', render: (row) => row.title },
            {
              key: 'state',
              header: 'State',
              render: (row) => <StatusBadge value={row.current_execution_state} />,
            },
          ]}
        />
        <p>
          <a href={`/human-required?project=${projectId}`}>View all →</a>
        </p>
      </section>

      <section>
        <h2>Recent Workflow Layer runs</h2>
        <Table
          rows={triggerdevRuns.items}
          rowKey={(row) => row.id}
          columns={[
            { key: 'task', header: 'Task', render: (row) => row.triggerdev_task_id },
            {
              key: 'status',
              header: 'Status',
              render: (row) => <StatusBadge value={row.triggerdev_status} />,
            },
            {
              key: 'feature',
              header: 'Feature run',
              render: (row) => row.linked_feature_run_id ?? '—',
            },
            { key: 'seen', header: 'Last seen', render: (row) => row.last_seen_at },
          ]}
        />
      </section>
    </div>
  );
}
