import { getApiClient } from '../../../lib/api-server';
import { StatusBadge } from '../../../components/status-badge';
import { KeyValue } from '../../../components/key-value';
import { Table } from '../../../components/table';
import { RunActions } from './run-actions';

export default async function FeatureDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { project?: string };
}): Promise<JSX.Element> {
  const client = getApiClient();
  const { feature, runs } = await client.getFeature(params.id);
  const projectId = searchParams.project ?? feature.project_id;
  const latestRun = runs[0];

  const [
    pullRequest,
    agentRuns,
    findings,
    disagreements,
    mergeGateEvaluations,
    workflowEvents,
    triggerdevRuns,
  ] = latestRun
    ? await Promise.all([
        client.getPullRequestByFeatureRun(latestRun.id).catch(() => null),
        client.listAgentRuns({ featureRunId: latestRun.id }, { limit: '20' }),
        client.listReviewFindings(latestRun.id, { limit: '20' }),
        client.listDisagreements({ featureRunId: latestRun.id }, { limit: '20' }),
        client.listMergeGateEvaluations(latestRun.id, { limit: '10' }),
        client.listWorkflowEvents({ featureRunId: latestRun.id }, { limit: '20' }),
        client.listTriggerdevRuns({ featureRunId: latestRun.id }, { limit: '10' }),
      ])
    : [
        null,
        { items: [] },
        { items: [] },
        { items: [] },
        { items: [] },
        { items: [] },
        { items: [] },
      ];

  return (
    <div>
      <h1>
        {feature.fr_id} — {feature.title}
      </h1>
      <KeyValue
        entries={[
          { label: 'Kind', value: feature.kind },
          { label: 'State', value: <StatusBadge value={feature.state} /> },
          { label: 'Priority', value: feature.priority },
          { label: 'Description', value: feature.description },
        ]}
      />

      <section>
        <h2>Feature runs</h2>
        <Table
          rows={runs}
          rowKey={(row) => row.id}
          columns={[
            { key: 'attempt', header: 'Attempt', render: (row) => row.attempt_no },
            {
              key: 'state',
              header: 'Execution state',
              render: (row) => <StatusBadge value={row.current_execution_state} />,
            },
            { key: 'outcome', header: 'Outcome', render: (row) => row.outcome ?? '—' },
            { key: 'version', header: 'Version', render: (row) => row.version },
          ]}
        />
      </section>

      {latestRun && (
        <>
          <section>
            <h2>Actions (latest run)</h2>
            <RunActions
              featureId={feature.id}
              featureRunId={latestRun.id}
              projectId={projectId}
              state={latestRun.current_execution_state}
              version={latestRun.version}
            />
          </section>

          {pullRequest && (
            <section>
              <h2>Pull request</h2>
              <KeyValue
                entries={[
                  {
                    label: 'PR',
                    value: (
                      <a href={`/pull-requests/${pullRequest.pr_number}?project=${projectId}`}>
                        #{pullRequest.pr_number}
                      </a>
                    ),
                  },
                  { label: 'State', value: <StatusBadge value={pullRequest.state} /> },
                  {
                    label: 'Review state',
                    value: <StatusBadge value={pullRequest.review_state} />,
                  },
                  { label: 'CI status', value: <StatusBadge value={pullRequest.ci_status} /> },
                  { label: 'Branch', value: pullRequest.branch_name },
                ]}
              />
            </section>
          )}

          <section>
            <h2>Agent runs</h2>
            <Table
              rows={agentRuns.items}
              rowKey={(row) => row.id}
              columns={[
                { key: 'role', header: 'Role', render: (row) => row.role },
                {
                  key: 'state',
                  header: 'State',
                  render: (row) => <StatusBadge value={row.state} />,
                },
                { key: 'adapter', header: 'Adapter', render: (row) => row.adapter_id },
              ]}
            />
          </section>

          <section>
            <h2>Review findings</h2>
            <Table
              rows={findings.items}
              rowKey={(row) => row.id}
              columns={[
                {
                  key: 'severity',
                  header: 'Severity',
                  render: (row) => <StatusBadge value={row.severity} />,
                },
                { key: 'description', header: 'Description', render: (row) => row.description },
                {
                  key: 'resolved',
                  header: 'Resolved',
                  render: (row) => (row.resolved ? 'yes' : 'no'),
                },
              ]}
            />
          </section>

          <section>
            <h2>Disagreements</h2>
            <Table
              rows={disagreements.items}
              rowKey={(row) => row.id}
              columns={[
                {
                  key: 'state',
                  header: 'State',
                  render: (row) => <StatusBadge value={row.state} />,
                },
                { key: 'resolution', header: 'Resolution', render: (row) => row.resolution ?? '—' },
              ]}
            />
          </section>

          <section>
            <h2>Merge gate evaluations</h2>
            <Table
              rows={mergeGateEvaluations.items}
              rowKey={(row) => row.id}
              columns={[
                {
                  key: 'decision',
                  header: 'Decision',
                  render: (row) => <StatusBadge value={row.final_decision} />,
                },
                { key: 'ci', header: 'CI status', render: (row) => row.ci_status ?? '—' },
                {
                  key: 'review',
                  header: 'Review status',
                  render: (row) => row.review_status ?? '—',
                },
                {
                  key: 'blocking',
                  header: 'Unresolved blocking',
                  render: (row) => row.unresolved_blocking_findings,
                },
                { key: 'evaluated', header: 'Evaluated at', render: (row) => row.evaluated_at },
              ]}
            />
          </section>

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
                { key: 'seen', header: 'Last seen', render: (row) => row.last_seen_at },
              ]}
            />
          </section>

          <section>
            <h2>Workflow events</h2>
            <Table
              rows={workflowEvents.items}
              rowKey={(row) => row.id}
              columns={[
                { key: 'type', header: 'Type', render: (row) => row.event_type },
                { key: 'created', header: 'Created', render: (row) => row.created_at },
              ]}
            />
          </section>
        </>
      )}
    </div>
  );
}
