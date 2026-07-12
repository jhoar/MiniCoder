import type { ReactElement } from 'react';
import { getApiClient } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { StatusBadge } from '../../components/status-badge';
import { DesignDocumentActions } from './document-actions';
import { GenerateDesignDocumentActions } from './generate-actions';

/**
 * Phase 17: the `generate`/`regenerate`/`request revision`/`approve` actions this page's buttons
 * previously rendered disabled ("Not available yet — Phase 17 scope") now dispatch real
 * state-machine commands, via `CommandButton`/Server Actions — see `document-actions.tsx`/
 * `generate-actions.tsx` and `actions.ts`. `/adapters` remains the one other page still carrying
 * that disabled-button posture (no adapter-registration command exists anywhere yet).
 */
export default async function DesignDocumentPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<ReactElement> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  const [projects, documents, status] = await Promise.all([
    client.listProjects({ limit: '100' }),
    client.listDesignDocuments(projectId, { limit: '20' }),
    client.getStatus(projectId),
  ]);

  const details = await Promise.all(documents.items.map((doc) => client.getDesignDocument(doc.id)));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Design Document</h1>
        <ProjectSwitcher projects={projects.items} currentProjectId={projectId} />
      </div>

      {status.project && (
        <div style={{ marginBottom: 16 }}>
          <span style={{ marginRight: 8 }}>
            Project state: <StatusBadge value={status.project.state} />
          </span>
          <GenerateDesignDocumentActions
            projectId={projectId}
            projectState={status.project.state}
            projectVersion={status.project.version}
          />
        </div>
      )}

      {details.length === 0 && (
        <p style={{ color: '#64748b' }}>No design documents have been generated yet.</p>
      )}

      {details.map(({ document, sections }) => (
        <section key={document.id} style={{ marginBottom: 24 }}>
          <h2>
            Document {document.id} — <StatusBadge value={document.state} /> (v{document.version})
          </h2>
          {status.project && (
            <DesignDocumentActions
              projectId={projectId}
              projectVersion={status.project.version}
              designDocumentId={document.id}
            />
          )}
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
