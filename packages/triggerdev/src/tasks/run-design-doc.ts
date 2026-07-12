import {
  ProjectState,
  AgentRole,
  AdapterRegistry,
  ExportDesignDocumentHandler,
  RecordDesignDocumentReadyHandler,
  TransactionalCommandExecutor,
  generateId,
  collectDesignDocumentEvidence,
  generateDesignDocumentSections,
  writeDesignDocumentSections,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient, DocumentationAgentAdapter } from '@minicoder/core';
import { WorkflowLockManager, LockConflictError } from '@minicoder/workflow';
import type { RunDesignDocPayload } from './types.js';
import { systemActor } from './actor.js';
import { isTransientRace as isTransientRaceShared } from './transient-race.js';
import { requireNonBlankEnvVar } from './env.js';

/** Resource key for the single-flight generation-cycle lock (see the `runImpl` doc comment). */
function designDocGenerationLockKey(projectId: string): string {
  return `design-doc-generation:${projectId}`;
}

export type { RunDesignDocPayload };

export interface RunDesignDocResult {
  projectId: string;
  generated: boolean;
  designDocumentId: string | null;
  artifactExportId: string | null;
  /** True when the adapter reported one or more required sections as missing/blank in its raw
   * output. When true, `generated` sections were still written (for operator visibility) but
   * export/record-ready were deliberately skipped — see the `runImpl` doc comment. */
  requiresRevision?: boolean;
}

const exportDesignDocumentHandler = new ExportDesignDocumentHandler();
const recordDesignDocumentReadyHandler = new RecordDesignDocumentReadyHandler();

// A concurrent invocation of this same task (e.g. two operators triggering generation at once)
// racing the same idempotency key is the only expected non-fatal race — this task never acquires
// the execution-lane lock (design-document generation is project-lifecycle-scoped, not
// feature-execution-scoped).
const EXPECTED_COMMAND_ERROR_TYPES = new Set(['concurrent-command', 'not-found']);

function isTransientRace(err: unknown): boolean {
  return isTransientRaceShared(err, EXPECTED_COMMAND_ERROR_TYPES);
}

export type DocumentationAdapterFactory = (opts: {
  projectName: string;
  projectDescription: string | null;
  featureSummaries: readonly string[];
  mergedPullRequestCount: number;
}) => Promise<DocumentationAgentAdapter>;

/** Constructs the real reference `ClaudeDocumentationAdapter` from env config — reuses the same
 * `CODE_GEN_BASE_URL`/`CODE_GEN_API_KEY`/`CODE_GEN_MODEL` env vars the Coder/Reviewer/Planner/
 * Arbiter default resolvers already use, mirroring that exact pattern. */
function resolveDefaultDocumentationAdapterFactory(): DocumentationAdapterFactory {
  return async (opts) => {
    const codeGenBaseUrl = requireNonBlankEnvVar(
      'CODE_GEN_BASE_URL',
      'run-design-doc requires an OpenAI-compatible endpoint to draft the design document — see ' +
        'docs/07-security-and-secrets.md §3.',
    );
    const codeGenApiKey = requireNonBlankEnvVar(
      'CODE_GEN_API_KEY',
      'run-design-doc requires an OpenAI-compatible endpoint to draft the design document — see ' +
        'docs/07-security-and-secrets.md §3.',
    );
    const codeGenModel = requireNonBlankEnvVar(
      'CODE_GEN_MODEL',
      'run-design-doc requires an OpenAI-compatible endpoint to draft the design document — see ' +
        'docs/07-security-and-secrets.md §3.',
    );
    const { ClaudeDocumentationAdapter, HttpDocumentationProvider } =
      await import('@minicoder/adapters-documentation');
    return new ClaudeDocumentationAdapter({
      documentationProvider: new HttpDocumentationProvider({
        baseUrl: codeGenBaseUrl,
        apiKey: codeGenApiKey,
        model: codeGenModel,
      }),
      ...opts,
    });
  };
}

export interface RunDesignDocDeps {
  documentationAdapterFactory?: DocumentationAdapterFactory;
}

interface ProjectRow {
  id: string;
  name: string;
  state: string;
  version: number;
}

interface DesignDocumentRow {
  id: string;
}

interface ArtifactExportRow {
  id: string;
}

interface PlanRow {
  id: string;
}

/**
 * Drives one design-document generation cycle: `implementation_complete`'s
 * `GenerateDesignDocumentCommand`/`RegenerateDesignDocumentCommand` handlers already moved the
 * project to `design_document_generating` and created a fresh `design_documents`/
 * `artifact_exports` row before this task ever runs (this task never dispatches those two
 * commands itself) — a separate, independently scheduled/triggered task from every other
 * project-lifecycle command dispatch, matching this codebase's established "never inline" rule
 * for GitHub-facing/execution tasks. It collects DB evidence, invokes
 * `DocumentationAgentAdapter`, writes the 13 sections, exports `final-design-document.md`
 * (`ExportDesignDocumentCommand`), and finally records the document ready
 * (`RecordDesignDocumentReadyCommand`) — moving the project to
 * `design_document_ready_for_review`.
 *
 * Deliberately does **not** write `agent_runs`/`agent_context_packs`/`cost_records` provenance via
 * `AgentRunRecorder` the way `run-coder.ts`/`run-review.ts` do for their adapter invocations —
 * a real, documented scope trade-off for this phase (see CLAUDE.md's Final Design Document
 * Generator Operational Constraints), not an oversight; a future pass can add it without changing
 * this task's public shape.
 *
 * If the adapter reports `requiresRevision: true` (a required section came back missing/blank in
 * its raw output — see `ClaudeDocumentationAdapter`/`generateDesignDocumentSections`), this task
 * still writes the (partially-placeholder) sections for operator visibility but deliberately does
 * **not** export or record-ready: an incomplete draft must never silently reach
 * `design_document_ready_for_review` looking like a clean success. The project is left at
 * `design_document_generating` with no in-flight run — the same "handler exists, caller decides
 * what happens next" posture `run-coder.ts` already establishes for an adapter failure leaving a
 * feature run at `coding`. An operator can inspect the draft sections directly and either retry
 * generation (once the underlying provider/config issue is fixed) or manually intervene.
 *
 * Single-flight per project: after the no-op state/row gates below, this task acquires a
 * `WorkflowLockManager` lock on `design-doc-generation:{projectId}` (mirroring
 * `execution-lane:{projectId}`'s shape, but a distinct resource — design-document generation is
 * project-lifecycle-scoped, not feature-execution-scoped, so it must not contend with or be
 * blocked by an unrelated in-flight feature-execution lock) and holds it for the entire adapter
 * call, section write, export, and record-ready sequence. This closes a real race (found in PR
 * review): the Web UI's "Retry generation" affordance and a scheduled/duplicate invocation could
 * otherwise both pass the initial no-op gates, both invoke the adapter, and the slower call could
 * overwrite `design_document_sections` — or even export a `requiresRevision: true` result — after
 * the faster call had already recorded the document ready. A conflicting concurrent invocation
 * (`LockConflictError`) is treated as an expected, non-fatal "another run is already in flight"
 * condition and returns a clean no-op, the same "transient race -> false, don't throw" posture
 * `start-next-feature.ts`/`github-reconciliation.ts` already establish for their own locks.
 */
export async function runImpl(
  payload: RunDesignDocPayload,
  db: DbClient,
  deps: RunDesignDocDeps = {},
): Promise<RunDesignDocResult> {
  const { projectId, correlationId, documentationAdapterName } = payload;

  const projectRows = await db.query<ProjectRow>(
    `SELECT id, name, state, version FROM projects WHERE id = ?`,
    [projectId],
  );
  const project = projectRows[0];
  if (!project || project.state !== ProjectState.DESIGN_DOCUMENT_GENERATING) {
    return { projectId, generated: false, designDocumentId: null, artifactExportId: null };
  }

  const designDocRows = await db.query<DesignDocumentRow>(
    `SELECT id FROM design_documents WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );
  const artifactRows = await db.query<ArtifactExportRow>(
    `SELECT id FROM artifact_exports WHERE project_id = ? AND artifact_type = 'design_document' AND state = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );
  const designDocumentId = designDocRows[0]?.id ?? null;
  const artifactExportId = artifactRows[0]?.id ?? null;
  if (!designDocumentId || !artifactExportId) {
    return { projectId, generated: false, designDocumentId, artifactExportId };
  }

  const lockManager = new WorkflowLockManager(db);
  let lock;
  try {
    lock = await lockManager.acquire(projectId, designDocGenerationLockKey(projectId), {
      holderId: `run-design-doc:${correlationId}`,
      ttlMs: 10 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof LockConflictError) {
      // Another generation cycle for this project is already in flight — a routine, expected
      // condition (e.g. a duplicate Web UI retry click), not a failure.
      return { projectId, generated: false, designDocumentId, artifactExportId };
    }
    throw err;
  }

  try {
    return await generateAndRecord({
      db,
      projectId,
      correlationId,
      documentationAdapterName,
      designDocumentId,
      artifactExportId,
      deps,
    });
  } finally {
    await lockManager.release(lock);
  }
}

interface GenerateAndRecordArgs {
  db: DbClient;
  projectId: string;
  correlationId: string;
  documentationAdapterName: string;
  designDocumentId: string;
  artifactExportId: string;
  deps: RunDesignDocDeps;
}

async function generateAndRecord(args: GenerateAndRecordArgs): Promise<RunDesignDocResult> {
  const {
    db,
    projectId,
    correlationId,
    documentationAdapterName,
    designDocumentId,
    artifactExportId,
    deps,
  } = args;

  // Adapter-name validation happens after the no-op state/row-existence gates above (not before,
  // as an earlier revision of this task did) — a harmless replay for a project already past
  // `design_document_generating` (or with no pending rows) must return a clean no-op even if the
  // registry entry for `documentationAdapterName` has since been deactivated/renamed, mirroring
  // how `run-coder.ts`/`run-review.ts` gate on run/project state before resolving their adapter.
  // Fail fast on an unregistered/unknown adapter name rather than silently ignoring the caller's
  // selection and always resolving the environment default — `registry.resolve()` throws
  // `UnknownAdapterError` for a name with no active `agent_adapters` row.
  //
  // NOTE: this resolves the `agent_adapters` DB record only (for validation/provenance), not a
  // runtime implementation — the same "registry resolve is not implementation selection"
  // separation `run-coder.ts`/`run-review.ts` already establish for `coderAdapterName`/
  // `reviewerAdapterName` (CLAUDE.md's Reference Coder Adapter Operational Constraints: "these are
  // not the same lookup"). The actual runtime instance always comes from the injected
  // `documentationAdapterFactory` below (or, absent one, `resolveDefaultDocumentationAdapterFactory()`,
  // which always constructs `ClaudeDocumentationAdapter`). There is exactly one shipped
  // `DocumentationAgentAdapter` reference implementation today — supporting a caller-selectable
  // choice among multiple registered implementations is real future work (the same class of gap
  // `run-coder.ts`'s `CoderAdapterFactory` doc comment already flags), not something this
  // validation call was ever meant to provide.
  await new AdapterRegistry(db).resolve(AgentRole.DOCUMENTATION, documentationAdapterName);

  const evidence = await collectDesignDocumentEvidence(db, projectId);
  const planRows = await db.query<PlanRow>(
    `SELECT id FROM implementation_plans WHERE project_id = ? AND state = 'activated_for_execution' ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );
  const planId = planRows[0]?.id ?? '';

  const documentationAdapterFactory =
    deps.documentationAdapterFactory ?? resolveDefaultDocumentationAdapterFactory();
  const adapter = await documentationAdapterFactory({
    projectName: evidence.project.name,
    projectDescription: evidence.project.description,
    featureSummaries: evidence.features.map((f) => `${f.frId}: ${f.title}`),
    mergedPullRequestCount: evidence.mergedPullRequests.length,
  });

  const generated = await generateDesignDocumentSections(adapter, evidence, {
    planId,
    correlationId,
  });
  await writeDesignDocumentSections(db, { designDocumentId, sections: generated.sections });

  if (generated.requiresRevision) {
    return {
      projectId,
      generated: false,
      designDocumentId,
      artifactExportId,
      requiresRevision: true,
    };
  }

  const executor = new TransactionalCommandExecutor(db);
  const actor = systemActor(correlationId);

  try {
    await executor.execute(exportDesignDocumentHandler, {
      commandId: generateId(),
      idempotencyKey: `export-design-document:${artifactExportId}`,
      payload: { projectId, designDocumentId, artifactExportId },
      actor,
      correlationId,
    } as CommandEnvelope<Record<string, unknown>>);
  } catch (err) {
    if (isTransientRace(err)) {
      return { projectId, generated: false, designDocumentId, artifactExportId };
    }
    throw err;
  }

  const refreshed = await db.query<ProjectRow>(
    `SELECT id, name, state, version FROM projects WHERE id = ?`,
    [projectId],
  );
  const currentProject = refreshed[0];
  if (!currentProject || currentProject.state !== ProjectState.DESIGN_DOCUMENT_GENERATING) {
    return { projectId, generated: true, designDocumentId, artifactExportId };
  }

  try {
    await executor.execute(recordDesignDocumentReadyHandler, {
      commandId: generateId(),
      idempotencyKey: `design-doc-ready:${projectId}:${designDocumentId}`,
      payload: {
        projectId,
        expectedVersion: currentProject.version,
        designDocumentId,
        artifactExportId,
      },
      actor,
      correlationId,
    } as CommandEnvelope<Record<string, unknown>>);
  } catch (err) {
    if (isTransientRace(err)) {
      return { projectId, generated: true, designDocumentId, artifactExportId };
    }
    throw err;
  }

  return { projectId, generated: true, designDocumentId, artifactExportId };
}
