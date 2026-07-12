import type { DbClient } from '../persistence/types.js';

/**
 * Evidence collected from the database (and, transitively, GitHub — via the already-tracked
 * `pull_requests` mirror table rather than a fresh live `GitHubClient` call: every merged PR this
 * project produced was already durably recorded by `reconcileGithubState()`/`RecordMergedHandler`
 * during execution, so re-fetching from GitHub live would just duplicate data this deployment
 * already has, with no new information — a deliberate simplification, not a missing integration).
 */
export interface DesignDocumentEvidence {
  readonly project: { id: string; name: string; description: string | null };
  readonly features: Array<{ frId: string; title: string; description: string; kind: string }>;
  readonly mergedPullRequests: Array<{
    prNumber: number;
    branchName: string;
    mergeSha: string | null;
    featureRunId: string;
  }>;
  readonly designDecisions: Array<{
    title: string;
    context: string | null;
    decision: string;
    consequences: string | null;
    status: string;
  }>;
  readonly glossaryTerms: Array<{ term: string; definition: string; category: string | null }>;
  readonly tableCount: number;
  readonly adapterCount: number;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
}

/** Collects everything `generateDesignDocumentSections()` needs to draft the 13 required sections
 * (docs/01 §13.2) from database evidence only — no chain-of-thought, no LLM call happens here. */
export async function collectDesignDocumentEvidence(
  db: DbClient,
  projectId: string,
): Promise<DesignDocumentEvidence> {
  const projectRows = await db.query<ProjectRow>(
    `SELECT id, name, description FROM projects WHERE id = ?`,
    [projectId],
  );
  const project = projectRows[0];
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const features = await db.query<{
    fr_id: string;
    title: string;
    description: string;
    kind: string;
  }>(
    `SELECT fr_id, title, description, kind FROM feature_requests WHERE project_id = ? ORDER BY priority ASC, fr_id ASC`,
    [projectId],
  );

  const mergedPrs = await db.query<{
    pr_number: number;
    branch_name: string;
    merge_sha: string | null;
    feature_run_id: string;
  }>(
    `SELECT pr.pr_number, pr.branch_name, pr.merge_sha, pr.feature_run_id
     FROM pull_requests pr
     JOIN feature_runs fr ON pr.feature_run_id = fr.id
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE freq.project_id = ? AND pr.state = 'merged'
     ORDER BY pr.pr_number ASC`,
    [projectId],
  );

  const decisions = await db.query<{
    title: string;
    context: string | null;
    decision: string;
    consequences: string | null;
    status: string;
  }>(
    `SELECT title, context, decision, consequences, status FROM design_decisions WHERE project_id = ? ORDER BY created_at ASC`,
    [projectId],
  );

  const glossary = await db.query<{ term: string; definition: string; category: string | null }>(
    `SELECT term, definition, category FROM glossary_terms WHERE project_id = ? OR project_id IS NULL ORDER BY term ASC`,
    [projectId],
  );

  const adapterCountRows = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM agent_adapters`,
    [],
  );

  return {
    project: { id: project.id, name: project.name, description: project.description },
    features: features.map((f) => ({
      frId: f.fr_id,
      title: f.title,
      description: f.description,
      kind: f.kind,
    })),
    mergedPullRequests: mergedPrs.map((p) => ({
      prNumber: p.pr_number,
      branchName: p.branch_name,
      mergeSha: p.merge_sha,
      featureRunId: p.feature_run_id,
    })),
    designDecisions: decisions,
    glossaryTerms: glossary,
    // Migration/table count is not queryable portably across SQLite/PostgreSQL without a
    // dialect-specific catalog query; the feature count is used as a proxy for "system scale" in
    // the Data Design section instead of a literal table count.
    tableCount: features.length,
    adapterCount: Number(adapterCountRows[0]?.n ?? 0),
  };
}
