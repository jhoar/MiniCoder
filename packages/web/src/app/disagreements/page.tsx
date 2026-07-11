import type { ReactElement } from 'react';
import { getApiClient } from '../../lib/api-server';
import type { DisagreementRow } from '@minicoder/api';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { StatusBadge } from '../../components/status-badge';
import { Table } from '../../components/table';

interface DisagreementWithFeature extends DisagreementRow {
  featureRequestId: string;
  featureProjectId: string;
}

/** `/features/[id]` expects a feature *request* ID, not a feature *run* ID (`feature_run_id`) —
 * these are distinct identifiers (a feature request can have multiple runs across retries), and
 * a disagreement's owning feature can belong to a *different* project than whichever one is
 * currently selected in this page's `?project=` param. Resolving through the run (for the request
 * ID) and the feature request (for its real project ID) fixes both a broken navigation link and a
 * cross-project link-context bug caught in PR review — see CLAUDE.md's Next.js Web UI Operational
 * Constraints for the general pattern. */
async function resolveDisagreementFeatures(
  client: ReturnType<typeof getApiClient>,
  disagreements: DisagreementRow[],
): Promise<DisagreementWithFeature[]> {
  return Promise.all(
    disagreements.map(async (d) => {
      const run = await client.getFeatureRun(d.feature_run_id);
      const { feature } = await client.getFeature(run.feature_request_id);
      return { ...d, featureRequestId: feature.id, featureProjectId: feature.project_id };
    }),
  );
}

export default async function DisagreementsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<ReactElement> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  // `/disagreements` has no project-scoping filter (see packages/api/src/read-models/governance.ts)
  // — this lists every open/escalated disagreement across the whole deployment, which is the best
  // this API surface supports today. Resolution happens from the linked feature's detail page,
  // where the feature run's current version is already known.
  const [projects, rawDisagreements, policyDecisions] = await Promise.all([
    client.listProjects({ limit: '100' }),
    client.listDisagreements({}, { limit: '50' }),
    client.listPolicyDecisions(projectId, { limit: '50' }),
  ]);
  const disagreements = await resolveDisagreementFeatures(client, rawDisagreements.items);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Disagreements</h1>
        <ProjectSwitcher projects={projects.items} currentProjectId={projectId} />
      </div>

      <section>
        <h2>Disagreements (all projects)</h2>
        <Table
          rows={disagreements}
          rowKey={(row) => row.id}
          columns={[
            { key: 'state', header: 'State', render: (row) => <StatusBadge value={row.state} /> },
            {
              key: 'feature',
              header: 'Feature',
              render: (row) => (
                <a href={`/features/${row.featureRequestId}?project=${row.featureProjectId}`}>
                  {row.featureRequestId}
                </a>
              ),
            },
            { key: 'cycle', header: 'Review cycle', render: (row) => row.review_cycle },
            { key: 'resolution', header: 'Resolution', render: (row) => row.resolution ?? '—' },
          ]}
        />
      </section>

      <section>
        <h2>Policy decisions (this project)</h2>
        <Table
          rows={policyDecisions.items}
          rowKey={(row) => row.id}
          columns={[
            { key: 'type', header: 'Policy type', render: (row) => row.policy_type },
            {
              key: 'decision',
              header: 'Decision',
              render: (row) => <StatusBadge value={row.decision} />,
            },
            { key: 'actor', header: 'Actor', render: (row) => row.actor ?? '—' },
            { key: 'decided', header: 'Decided at', render: (row) => row.decided_at },
          ]}
        />
      </section>
    </div>
  );
}
