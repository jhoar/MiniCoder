import { getApiClient } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { StatusBadge } from '../../components/status-badge';

/**
 * Explicitly read-only (decision #5 of the Phase 15 plan): no `generate final design document` /
 * `approve final design document` / `request revision` command handler exists anywhere in
 * `packages/core` or `packages/api` yet — Phase 17 scope (see CLAUDE.md's Orchestrator API
 * Operational Constraints: "generate/approve final design document are not built"). Rather than
 * wiring these buttons to a nonexistent endpoint, or omitting them silently, they render visibly
 * disabled with an honest label — the same posture CLAUDE.md documents for other tracked gaps
 * (e.g. issue #61's unwired TaskTriggerClient).
 */
export default async function DesignDocumentPage({
  searchParams,
}: {
  searchParams: { project?: string };
}): Promise<JSX.Element> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  const [projects, documents] = await Promise.all([
    client.listProjects({ limit: '100' }),
    client.listDesignDocuments(projectId, { limit: '20' }),
  ]);

  const details = await Promise.all(documents.items.map((doc) => client.getDesignDocument(doc.id)));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Design Document</h1>
        <ProjectSwitcher projects={projects.items} currentProjectId={projectId} />
      </div>

      {details.length === 0 && (
        <p style={{ color: '#64748b' }}>No design documents have been generated yet.</p>
      )}

      {details.map(({ document, sections }) => (
        <section key={document.id} style={{ marginBottom: 24 }}>
          <h2>
            Document {document.id} — <StatusBadge value={document.state} /> (v{document.version})
          </h2>
          <div style={{ marginBottom: 8 }}>
            <button disabled title="Not available yet — no backend command exists (Phase 17 scope)">
              Request revision
            </button>{' '}
            <button disabled title="Not available yet — no backend command exists (Phase 17 scope)">
              Approve
            </button>
          </div>
          {sections
            .sort((a, b) => a.order_index - b.order_index)
            .map((section) => (
              <div key={section.id} style={{ marginBottom: 12 }}>
                <h3>{section.section_name}</h3>
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                  {section.content ?? '(empty)'}
                </pre>
              </div>
            ))}
        </section>
      ))}
    </div>
  );
}
