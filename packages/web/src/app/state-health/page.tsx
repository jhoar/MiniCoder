import type { ReactElement } from 'react';
import { getApiClient } from '../../lib/api-server';
import { tryOperatorCheck } from '../../lib/try-operator-check';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { StatusBadge } from '../../components/status-badge';
import { Table } from '../../components/table';
import { ReconcileButton } from './reconcile-button';
import type { DoctorResult, ValidationResult } from '@minicoder/api';

export default async function StateHealthPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<ReactElement> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  const [projects, triggerdevRuns, doctor, validation] = await Promise.all([
    client.listProjects({ limit: '100' }),
    client.listTriggerdevRuns({ projectId }, { limit: '50' }),
    tryOperatorCheck<DoctorResult>(() => client.getDoctorStatus(projectId)),
    tryOperatorCheck<ValidationResult>(() => client.getValidateStatus(projectId)),
  ]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>State Health</h1>
        <ProjectSwitcher projects={projects.items} currentProjectId={projectId} />
      </div>

      <section>
        <h2>Workflow Layer runs</h2>
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

      <section>
        <h2>Doctor checks</h2>
        {doctor.kind === 'forbidden' && (
          <p style={{ color: '#64748b' }}>Requires operator role or above.</p>
        )}
        {doctor.kind === 'error' && (
          <p style={{ color: '#b91c1c' }}>Failed to load doctor checks: {doctor.detail}</p>
        )}
        {doctor.kind === 'ok' && (
          <>
            <p>
              Overall:{' '}
              {doctor.data.healthy ? <StatusBadge value="ok" /> : <StatusBadge value="error" />}
            </p>
            <Table
              rows={doctor.data.checks}
              rowKey={(row) => row.name}
              columns={[
                { key: 'name', header: 'Check', render: (row) => row.name },
                {
                  key: 'severity',
                  header: 'Severity',
                  render: (row) => <StatusBadge value={row.severity} />,
                },
                { key: 'count', header: 'Count', render: (row) => row.count },
                {
                  key: 'auto',
                  header: 'Auto-clearable',
                  render: (row) => (row.autoClearable ? 'yes' : 'no'),
                },
              ]}
            />
          </>
        )}
      </section>

      <section>
        <h2>Validation</h2>
        {validation.kind === 'forbidden' && (
          <p style={{ color: '#64748b' }}>Requires operator role or above.</p>
        )}
        {validation.kind === 'error' && (
          <p style={{ color: '#b91c1c' }}>Failed to load validation: {validation.detail}</p>
        )}
        {validation.kind === 'ok' && (
          <p>
            Checked {validation.data.checkedRuns} feature runs —{' '}
            {validation.data.valid ? (
              <StatusBadge value="valid" />
            ) : (
              <StatusBadge value="invalid" />
            )}{' '}
            ({validation.data.violations.length} violations)
          </p>
        )}
      </section>

      <section>
        <h2>Reconcile</h2>
        <ReconcileButton projectId={projectId} />
      </section>
    </div>
  );
}
