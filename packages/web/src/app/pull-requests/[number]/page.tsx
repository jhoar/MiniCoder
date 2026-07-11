import type { ReactElement } from 'react';
import { getApiClient } from '../../../lib/api-server';
import { resolveProjectId } from '../../../lib/project';
import { StatusBadge } from '../../../components/status-badge';
import { KeyValue } from '../../../components/key-value';
import { Table } from '../../../components/table';

export default async function PullRequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>;
  searchParams: Promise<{ project?: string }>;
}): Promise<ReactElement> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  const { number } = await params;
  const prNumber = Number(number);
  const pr = await client.findPullRequestByNumber(projectId, prNumber);

  if (!pr) {
    return <p>No pull request #{prNumber} found for this project.</p>;
  }

  const [featureRun, findings, mergeGateEvaluations] = await Promise.all([
    client.getFeatureRun(pr.feature_run_id),
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
            // `/features/[id]` expects a feature *request* ID, not a feature *run* ID — these are
            // distinct identifiers (a feature request can have multiple runs across retries). The
            // link must resolve through the run's `feature_request_id`, not use `pr.feature_run_id`
            // directly (a real navigation bug caught in PR review — see CLAUDE.md's Next.js Web UI
            // Operational Constraints for the general pattern).
            label: 'Feature',
            value: (
              <a href={`/features/${featureRun.feature_request_id}?project=${projectId}`}>
                {featureRun.feature_request_id}
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
