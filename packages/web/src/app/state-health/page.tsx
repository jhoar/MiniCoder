import { getApiClient, ApiError } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { StatusBadge } from '../../components/status-badge';
import { Table } from '../../components/table';
import { ReconcileButton } from './reconcile-button';
import type { DoctorResult, ValidationResult } from '@minicoder/api';

/** `doctor`/`validate` require `operator`+ (backend-enforced). A `viewer`-role key gets a 403 —
 * caught here and rendered as an omitted section, mirroring `packages/tui`'s own established
 * "the API enforces authorization, the UI never duplicates the check, just degrades gracefully"
 * convention (see CLAUDE.md's Ink Text UI section and this package's own operational constraints). */
async function tryOperatorCheck<T>(fn: () => Promise<T>): Promise<T | 'forbidden' | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) return 'forbidden';
    return null;
  }
}

export default async function StateHealthPage({
  searchParams,
}: {
  searchParams: { project?: string };
}): Promise<JSX.Element> {
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
        {doctor === 'forbidden' && (
          <p style={{ color: '#64748b' }}>Requires operator role or above.</p>
        )}
        {doctor && doctor !== 'forbidden' && (
          <>
            <p>
              Overall: {doctor.healthy ? <StatusBadge value="ok" /> : <StatusBadge value="error" />}
            </p>
            <Table
              rows={doctor.checks}
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
        {validation === 'forbidden' && (
          <p style={{ color: '#64748b' }}>Requires operator role or above.</p>
        )}
        {validation && validation !== 'forbidden' && (
          <p>
            Checked {validation.checkedRuns} feature runs —{' '}
            {validation.valid ? <StatusBadge value="valid" /> : <StatusBadge value="invalid" />} (
            {validation.violations.length} violations)
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
