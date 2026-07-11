import type { ReactElement } from 'react';
import { getApiClient } from '../../lib/api-server';
import { resolveProjectId } from '../../lib/project';
import { ProjectSwitcher } from '../../components/project-switcher';
import { StatusBadge } from '../../components/status-badge';
import { Table } from '../../components/table';
import { SessionActions, QuestionAnswerForm } from './session-actions';

export default async function ClarificationPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<ReactElement> {
  const client = getApiClient();
  const projectId = await resolveProjectId(searchParams);
  const [projects, sessions] = await Promise.all([
    client.listProjects({ limit: '100' }),
    client.listClarificationSessions(projectId, { limit: '20' }),
  ]);

  const details = await Promise.all(
    sessions.items.map((session) => client.getClarificationSession(session.id)),
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Clarification</h1>
        <ProjectSwitcher projects={projects.items} currentProjectId={projectId} />
      </div>

      {details.map(({ session, questions }) => (
        <section key={session.id} style={{ marginBottom: 24 }}>
          <h2>
            Session {session.id} — <StatusBadge value={session.status} /> (round {session.round}/
            {session.max_rounds})
          </h2>
          <SessionActions
            sessionId={session.id}
            projectId={projectId}
            status={session.status}
            version={session.version}
          />
          <Table
            rows={questions}
            rowKey={(row) => row.id}
            emptyLabel="No questions yet."
            columns={[
              { key: 'round', header: 'Round', render: (row) => row.round },
              { key: 'question', header: 'Question', render: (row) => row.question },
              {
                key: 'answer',
                header: 'Answer',
                render: (row) => (
                  <QuestionAnswerForm question={row} sessionId={session.id} projectId={projectId} />
                ),
              },
            ]}
          />
        </section>
      ))}
      {sessions.items.length === 0 && (
        <p style={{ color: '#64748b' }}>No clarification sessions yet.</p>
      )}
    </div>
  );
}
