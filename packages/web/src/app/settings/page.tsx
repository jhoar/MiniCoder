import type { ReactElement } from 'react';
import { getApiClient } from '../../lib/api-server';
import { resolveApiConfig } from '../../lib/config';
import { KeyValue } from '../../components/key-value';

export default async function SettingsPage(): Promise<ReactElement> {
  const client = getApiClient();
  const whoami = await client.getWhoami();
  const config = resolveApiConfig();

  return (
    <div>
      <h1>Settings</h1>
      <KeyValue
        entries={[
          { label: 'Orchestrator API URL', value: config.baseUrl },
          { label: 'Actor id', value: whoami.id },
          { label: 'Role', value: whoami.role },
          { label: 'Actor kind', value: whoami.actorKind },
          { label: 'Display name', value: whoami.displayName ?? '—' },
        ]}
      />
      <p style={{ color: '#64748b' }}>
        The Orchestrator API key configured for this deployment is never rendered — see
        CLAUDE.md&apos;s &quot;Next.js Web UI Operational Constraints&quot; section.
      </p>
    </div>
  );
}
