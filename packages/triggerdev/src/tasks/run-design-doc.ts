import {
  ProjectState,
  AgentRole,
  AdapterRegistry,
  AgentRunRecorder,
  ExportDesignDocumentHandler,
  RecordDesignDocumentReadyHandler,
  TransactionalCommandExecutor,
  generateId,
  collectDesignDocumentEvidence,
  buildDocumentationInput,
  normalizeDocumentationOutput,
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

/**
 * Issue #70: `resolveDefaultDocumentationAdapterFactory()` below always constructs
 * `ClaudeDocumentationAdapter`, regardless of what `documentationAdapterName` the caller supplied
 * — `AdapterRegistry.resolve()` (in `generateAndRecord` below) was, and remains, validation/
 * provenance-only, the same "registry resolve is not implementation selection" separation
 * `run-coder.ts`/`run-review.ts` establish for `coderAdapterName`/`reviewerAdapterName`. There is
 * exactly one shipped `DocumentationAgentAdapter` reference implementation today, so silently
 * running it under a caller-supplied name that didn't match was a real (if narrow) surprise risk:
 * a caller requesting a not-yet-built second implementation by name would silently get
 * `ClaudeDocumentationAdapter` instead of an actionable error. Fixed per the issue's option 2
 * (explicit rejection, not full multi-adapter selection — real multi-adapter selection is out of
 * scope until a second implementation actually exists): this constant must match the caller-facing
 * default `documentationAdapterName` (`packages/web/src/app/design-document/actions.ts`'s own
 * identical constant; the two are not unified into one shared export solely because the Web UI
 * package deliberately carries no runtime dependency on `@minicoder/triggerdev`/`@minicoder/core`
 * for a one-line string). This check only applies on the *default* (non-injected) factory path —
 * see the call site in `generateAndRecord` — a caller that injects its own
 * `documentationAdapterFactory` (every current test) also controls the name it registers under, so
 * there is no silent mismatch for that path to catch.
 */
export const DEFAULT_DOCUMENTATION_ADAPTER_NAME = 'ClaudeDocumentationAdapter';

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

// Issue #72: the same simplification `run-coder.ts` already documents — a configurable per-1K-
// token price rather than real per-model pricing tables (Phase 16 observability scope) — applied
// to the Documentation role. Defaults match run-coder.ts's own gpt-4o-mini-class approximation;
// override via env for the configured provider/model.
const DEFAULT_PRICE_PER_1K_INPUT_TOKENS = 0.00015;
const DEFAULT_PRICE_PER_1K_OUTPUT_TOKENS = 0.0006;

const DOCUMENTATION_PROMPT_TEMPLATE_VERSION = 'documentation-v1';

/** Mirrors `run-coder.ts`'s `resolvePromptTemplateVersion()` exactly — a blank/whitespace-only
 * override must not silently degrade run provenance to an empty string. */
function resolvePromptTemplateVersion(): string {
  const raw = process.env['DOCUMENTATION_PROMPT_TEMPLATE_VERSION'];
  if (raw === undefined) return DOCUMENTATION_PROMPT_TEMPLATE_VERSION;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : DOCUMENTATION_PROMPT_TEMPLATE_VERSION;
}

/** Mirrors `run-coder.ts`'s `parsePriceEnvVar()` exactly — a malformed, negative, non-finite, or
 * blank/whitespace-only pricing env var must never silently poison a persisted `cost_records` row. */
function parsePriceEnvVar(envVarName: string, fallback: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`run-design-doc: ${envVarName} is set but blank; falling back to ${fallback}`);
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    // eslint-disable-next-line no-console
    console.error(
      `run-design-doc: ${envVarName}="${raw}" is not a finite, non-negative number; falling back to ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

function computeCostUsd(inputTokens: number, outputTokens: number): number {
  const pricePerKInput = parsePriceEnvVar(
    'DOCUMENTATION_PRICE_PER_1K_INPUT_TOKENS',
    DEFAULT_PRICE_PER_1K_INPUT_TOKENS,
  );
  const pricePerKOutput = parsePriceEnvVar(
    'DOCUMENTATION_PRICE_PER_1K_OUTPUT_TOKENS',
    DEFAULT_PRICE_PER_1K_OUTPUT_TOKENS,
  );
  return (inputTokens / 1000) * pricePerKInput + (outputTokens / 1000) * pricePerKOutput;
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
 * Writes `agent_runs`/`agent_context_packs`/`cost_records` provenance via `AgentRunRecorder`
 * (issue #72) the same way `run-coder.ts`/`run-review.ts` do for their own adapter invocations —
 * this was a documented, deliberate scope trade-off when this task first shipped (a complete
 * vertical slice through every other layer took priority within that phase's time budget), closed
 * here rather than left open indefinitely.
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
interface GenerationTargets {
  designDocumentId: string;
  artifactExportId: string;
}

/** Reads whether this project currently has generation work pending: `design_document_generating`
 * state plus a latest `design_documents` row and a `pending` `artifact_exports` row. Called twice
 * by `runImpl` — once before lock acquisition (a fast no-op path that avoids the lock-manager
 * round trip for the common "nothing to do" case) and once again immediately after acquiring the
 * lock (the authoritative read the rest of the generation cycle actually uses). */
async function readGenerationTargets(
  db: DbClient,
  projectId: string,
): Promise<GenerationTargets | null> {
  const projectRows = await db.query<ProjectRow>(
    `SELECT id, name, state, version FROM projects WHERE id = ?`,
    [projectId],
  );
  const project = projectRows[0];
  if (!project || project.state !== ProjectState.DESIGN_DOCUMENT_GENERATING) {
    return null;
  }

  const designDocRows = await db.query<DesignDocumentRow>(
    `SELECT id FROM design_documents WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );
  const artifactRows = await db.query<ArtifactExportRow>(
    `SELECT id FROM artifact_exports WHERE project_id = ? AND artifact_type = 'design_document' AND state = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );
  const designDocumentId = designDocRows[0]?.id;
  const artifactExportId = artifactRows[0]?.id;
  if (!designDocumentId || !artifactExportId) {
    return null;
  }
  return { designDocumentId, artifactExportId };
}

export async function runImpl(
  payload: RunDesignDocPayload,
  db: DbClient,
  deps: RunDesignDocDeps = {},
): Promise<RunDesignDocResult> {
  const { projectId, correlationId, documentationAdapterName } = payload;

  const preLockTargets = await readGenerationTargets(db, projectId);
  if (!preLockTargets) {
    return { projectId, generated: false, designDocumentId: null, artifactExportId: null };
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
      return {
        projectId,
        generated: false,
        designDocumentId: preLockTargets.designDocumentId,
        artifactExportId: preLockTargets.artifactExportId,
      };
    }
    throw err;
  }

  try {
    // Re-read the generation targets NOW THAT THE LOCK IS HELD, rather than trusting the
    // pre-lock snapshot above — closes a real race (found in PR review): a second invocation
    // could pass the pre-lock check, block on `acquire()` until a first, faster invocation
    // finishes and releases the lock, then proceed using stale `designDocumentId`/
    // `artifactExportId` values that no longer describe pending work (the project may have
    // already advanced past `design_document_generating`, or a new generation cycle may have
    // replaced the pending artifact). The lock only prevents two invocations from running the
    // generation body *concurrently* — it does not, by itself, invalidate data a delayed
    // invocation already read before the lock existed.
    const targets = await readGenerationTargets(db, projectId);
    if (!targets) {
      return { projectId, generated: false, designDocumentId: null, artifactExportId: null };
    }
    return await generateAndRecord({
      db,
      projectId,
      correlationId,
      documentationAdapterName,
      designDocumentId: targets.designDocumentId,
      artifactExportId: targets.artifactExportId,
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
  // NOTE: this resolves the `agent_adapters` DB record for both validation and (issue #72)
  // `AgentRunRecorder` provenance — it is still not, by itself, runtime implementation selection,
  // the same "registry resolve is not implementation selection" separation `run-coder.ts`/
  // `run-review.ts` already establish for `coderAdapterName`/`reviewerAdapterName` (CLAUDE.md's
  // Reference Coder Adapter Operational Constraints: "these are not the same lookup"). The actual
  // runtime instance always comes from the injected `documentationAdapterFactory` below (or,
  // absent one, `resolveDefaultDocumentationAdapterFactory()`, which always constructs
  // `ClaudeDocumentationAdapter` — see `DEFAULT_DOCUMENTATION_ADAPTER_NAME`'s doc comment (issue
  // #70) for why the *default* path additionally rejects a caller-supplied name that doesn't match
  // it, rather than silently running the default under a different name).
  const registry = new AdapterRegistry(db);
  const adapterRecord = await registry.resolve(AgentRole.DOCUMENTATION, documentationAdapterName);

  const evidence = await collectDesignDocumentEvidence(db, projectId);
  const planRows = await db.query<PlanRow>(
    `SELECT id FROM implementation_plans WHERE project_id = ? AND state = 'activated_for_execution' ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );
  const planId = planRows[0]?.id ?? '';

  // PR #73 review fix (MEDIUM-3): built once and reused for both adapter construction and the
  // recorded context pack below — this is the full evidence bundle the documentation adapter
  // actually sends to the provider (`ClaudeDocumentationAdapterOptions`), not just the narrow
  // `DocumentationInput` contract. Previously only `documentationInput` was recorded, so a
  // generated design document could not be fully reconstructed from `agent_context_packs` alone:
  // `projectName`/`projectDescription`/`featureSummaries`/`mergedPullRequestCount` were used to
  // drive the LLM call but never persisted as provenance.
  // PR #73 review fix (round 2, LOW-1): frozen before being handed to either factory below — a
  // custom `documentationAdapterFactory` (an extension point, so not fully trusted) could
  // otherwise mutate this object or its `featureSummaries` array in place before returning, and
  // since the exact same reference is persisted into the context pack further down, the recorded
  // provenance would then reflect the adapter's mutated view rather than the real evidence that
  // was actually computed. `Object.freeze` throws in strict mode / silently no-ops on a mutation
  // attempt either way, so the persisted snapshot is guaranteed to match what was built here.
  const adapterEvidence = Object.freeze({
    projectName: evidence.project.name,
    projectDescription: evidence.project.description,
    featureSummaries: Object.freeze(evidence.features.map((f) => `${f.frId}: ${f.title}`)),
    mergedPullRequestCount: evidence.mergedPullRequests.length,
  });

  let adapter: DocumentationAgentAdapter;
  if (deps.documentationAdapterFactory) {
    adapter = await deps.documentationAdapterFactory(adapterEvidence);
  } else {
    // Issue #70: only the *default* (non-injected) factory path is guarded — a caller injecting
    // its own factory (every current test) also controls the name it registered that adapter
    // under, so there is no silent name/implementation mismatch for this check to catch there.
    if (documentationAdapterName !== DEFAULT_DOCUMENTATION_ADAPTER_NAME) {
      throw new Error(
        `run-design-doc: documentationAdapterName "${documentationAdapterName}" is not supported ` +
          `by the default adapter resolver — only "${DEFAULT_DOCUMENTATION_ADAPTER_NAME}" is ` +
          'currently implemented. Inject a documentationAdapterFactory (RunDesignDocDeps) to use ' +
          'a different implementation.',
      );
    }
    adapter = await resolveDefaultDocumentationAdapterFactory()(adapterEvidence);
  }

  const documentationInput = buildDocumentationInput(evidence, { planId, correlationId });

  const recorder = new AgentRunRecorder(db, registry);
  const { output } = await recorder.record(
    {
      adapterId: adapterRecord.id,
      role: AgentRole.DOCUMENTATION,
      projectId,
      input: documentationInput,
      capabilitiesUsed: ['can_generate_design_document'],
      contextPack: { content: { documentationInput, adapterEvidence } },
      promptTemplateVersion: resolvePromptTemplateVersion(),
      costExtractor: (outcome) => {
        if (!outcome.ok) return null;
        const out = outcome.output as { tokensUsed?: { input: number; output: number } };
        if (!out.tokensUsed) return null;
        return {
          inputTokens: out.tokensUsed.input,
          outputTokens: out.tokensUsed.output,
          costUsd: computeCostUsd(out.tokensUsed.input, out.tokensUsed.output),
          provider: process.env['CODE_GEN_PROVIDER_NAME'] ?? 'openai-compatible',
          model: process.env['CODE_GEN_MODEL'],
        };
      },
    },
    () => adapter.run(documentationInput),
  );

  const generated = normalizeDocumentationOutput(output);
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
