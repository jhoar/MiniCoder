import { getApiClient } from '../../../lib/api-server';
import { resolveProjectId } from '../../../lib/project';
import { StatusBadge } from '../../../components/status-badge';
import { KeyValue } from '../../../components/key-value';
import { Table } from '../../../components/table';

export default async function PullRequestDetailPage({
  params,
  searchParams,
}: {
  params: { number: string };
  searchParams: { project?: string };
}): Promise<JSX.Element> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  const prNumber = Number(params.number);
  const pr = await client.findPullRequestByNumber(projectId, prNumber);

  if (!pr) {
    return <p>No pull request #{prNumber} found for this project.</p>;
  }

  const [findings, mergeGateEvaluations] = await Promise.all([
    client.listReviewFindings(pr.feature_run_id, { limit: '20' }),
    client.listMergeGateEvaluations(pr.feature_run_id, { limit: '10' }),
  ]);

  return (
    <div>
      <h1>Pull Request #{pr.pr_number}</h1>
      <KeyValue
        entries={[
          { label: 'State', value: <StatusBadge value={pr.state} /> },
          { label: 'Review state', value: <StatusBadge value={pr.review_state} /> },
          { label: 'CI status', value: <StatusBadge value={pr.ci_status} /> },
          { label: 'Branch', value: `${pr.branch_name} -> ${pr.base_branch}` },
          {
            label: 'Mergeable',
            value: pr.mergeable === null ? 'unknown' : pr.mergeable ? 'yes' : 'no',
          },
          {
            label: 'Feature run',
            value: (
              <a href={`/features/${pr.feature_run_id}?project=${projectId}`}>
                {pr.feature_run_id}
              </a>
            ),
          },
        ]}
      />

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
            { key: 'resolved', header: 'Resolved', render: (row) => (row.resolved ? 'yes' : 'no') },
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
            { key: 'evaluated', header: 'Evaluated at', render: (row) => row.evaluated_at },
          ]}
        />
      </section>
    </div>
  );
}
