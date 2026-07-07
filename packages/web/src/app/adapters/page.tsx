import type { ReactElement } from 'react';
import { getApiClient } from '../../lib/api-server';
import { Table } from '../../components/table';

/** Read-only: no command handler registers/mutates adapter config from any API route today (see
 * CLAUDE.md's "Next.js Web UI Operational Constraints" section). This page mirrors what
 * `minicoder adapters` (Text UI) already exposes over the same read models. */
export default async function AdaptersPage(): Promise<ReactElement> {
  const client = getApiClient();
  const [adapters, configurations] = await Promise.all([
    client.listAgentAdapters({ limit: '100' }),
    client.listAgentConfigurations(undefined, { limit: '100' }),
  ]);

  return (
    <div>
      <h1>Adapters</h1>
      <p style={{ color: '#64748b' }}>
        Read-only — no backend command exists to register/mutate adapters from the API yet.
      </p>

      <section>
        <h2>Registered adapters</h2>
        <Table
          rows={adapters.items}
          rowKey={(row) => row.id}
          columns={[
            { key: 'role', header: 'Role', render: (row) => row.role },
            { key: 'name', header: 'Name', render: (row) => row.name },
            { key: 'impl', header: 'Implementation', render: (row) => row.implementation },
            { key: 'active', header: 'Active', render: (row) => (row.is_active ? 'yes' : 'no') },
            { key: 'version', header: 'Version', render: (row) => row.version },
          ]}
        />
      </section>

      <section>
        <h2>Configurations</h2>
        <Table
          rows={configurations.items}
          rowKey={(row) => row.id}
          columns={[
            { key: 'adapter', header: 'Adapter', render: (row) => row.adapter_id },
            {
              key: 'project',
              header: 'Project scope',
              render: (row) => row.project_id ?? 'default',
            },
            { key: 'version', header: 'Version', render: (row) => row.version },
          ]}
        />
      </section>
    </div>
  );
}
