import {
  AdapterRegistry,
  AgentRole,
  AgentRunRecorder,
  FeatureExecutionState,
  RecordCodePushedHandler,
  TransactionalCommandExecutor,
  generateId,
} from '@minicoder/core';
import type {
  CommandEnvelope,
  CoderAgentAdapter,
  CoderInput,
  DbClient,
  GitHubClient,
} from '@minicoder/core';
import { ExecutionLane } from '@minicoder/workflow';
import type { AcquiredLock } from '@minicoder/workflow';
import type { RunCoderPayload } from './types.js';
import { systemActor } from './actor.js';
import { isTransientRace as isTransientRaceShared } from './transient-race.js';
import { requireNonBlankEnvVar } from './env.js';
import { budgetPreflightCheck, resolveEstimatedCostUsd } from './budget-preflight.js';

export type { RunCoderPayload };

export interface RunCoderResult {
  projectId: string;
  featureRunId: string;
  pushed: boolean;
  prNumber: number | null;
}

const recordCodePushedHandler = new RecordCodePushedHandler();
const EXECUTION_LANE_TTL_MS = 30_000;

// This task never attempts SelectFeature/StartCoding-style transitions of its own, so the
// expected-race set is narrower than start-next-feature.ts's: only an in-flight idempotency-key
// race with a concurrent invocation of this same command, or the feature run vanishing underneath
// us (a genuinely unexpected but non-fatal condition for a scheduled/opportunistic task).
const EXPECTED_COMMAND_ERROR_TYPES = new Set(['concurrent-command', 'not-found']);

/** See `transient-race.ts`'s `isTransientRace()` doc comment for the shared
 * LockConflictError/OptimisticLockError/StaleFenceError classification this task reuses. */
function isTransientRace(err: unknown): boolean {
  return isTransientRaceShared(err, EXPECTED_COMMAND_ERROR_TYPES);
}

export type GithubClientFactory = () => Promise<GitHubClient>;
/** Builds a fresh `CoderAgentAdapter` instance for this one run, given the project's repo URL —
 * a factory (not a singleton) because a single deployment can serve multiple projects with
 * different repos, and `CoderInput` itself carries no repo/credential fields (docs/06 Phase 9). */
export type CoderAdapterFactory = (repoUrl: string) => Promise<CoderAgentAdapter>;

/**
 * No live GitHubClient is injectable at the Trigger.dev task boundary the way an adapter
 * instance is — constructs an OctokitGitHubClient directly from env, mirroring
 * github-reconciliation.ts's resolveDefaultGithubClientFactory (GitHub credentials are a single
 * deployment-wide secret, not a per-call injected dependency). `requireNonBlankEnvVar` is shared
 * with that task (LOW-1 code-review fix, round 5) so both entrypoints reject whitespace-only
 * required env vars identically instead of drifting apart.
 */
function resolveDefaultGithubClientFactory(): GithubClientFactory {
  return async () => {
    const token = requireNonBlankEnvVar(
      'GITHUB_TOKEN',
      'run-coder requires a GitHub credential (GitHub App installation token or PAT) to open a ' +
        'pull request after pushing — see docs/07-security-and-secrets.md §3.',
    );
    const { OctokitGitHubClient } = await import('@minicoder/github');
    return new OctokitGitHubClient({ auth: token });
  };
}

/**
 * Constructs the real reference `CodexCoderAdapter` from env config (sandbox image/network,
 * code-generation endpoint, GitHub token) — a dynamic import so `packages/triggerdev` only pays
 * for `@minicoder/adapters-coder` when this default path is actually exercised, the same posture
 * `resolveDefaultGithubClientFactory` takes for `@minicoder/github`. Test scenarios inject
 * `MockCoderAdapter` directly instead of going through this factory.
 */
function resolveDefaultCoderAdapterFactory(): CoderAdapterFactory {
  return async (repoUrl: string) => {
    const githubToken = requireNonBlankEnvVar(
      'GITHUB_TOKEN',
      'run-coder requires a GitHub credential to clone/push — see docs/07-security-and-secrets.md §3.',
    );
    const codeGenBaseUrl = requireNonBlankEnvVar(
      'CODE_GEN_BASE_URL',
      'run-coder requires an OpenAI-compatible code-generation endpoint — see ' +
        'docs/07-security-and-secrets.md §3.',
    );
    const codeGenApiKey = requireNonBlankEnvVar(
      'CODE_GEN_API_KEY',
      'run-coder requires an OpenAI-compatible code-generation endpoint — see ' +
        'docs/07-security-and-secrets.md §3.',
    );
    const codeGenModel = requireNonBlankEnvVar(
      'CODE_GEN_MODEL',
      'run-coder requires an OpenAI-compatible code-generation endpoint — see ' +
        'docs/07-security-and-secrets.md §3.',
    );
    const { CodexCoderAdapter, HttpCodeGenerationProvider, CoderSandbox } =
      await import('@minicoder/adapters-coder');
    return new CodexCoderAdapter({
      repoUrl,
      githubToken,
      codeGenerationProvider: new HttpCodeGenerationProvider({
        baseUrl: codeGenBaseUrl,
        apiKey: codeGenApiKey,
        model: codeGenModel,
      }),
      createSandbox: () =>
        new CoderSandbox({
          image: process.env['CODER_SANDBOX_IMAGE'] ?? 'minicoder/coder-sandbox:latest',
          network: process.env['CODER_SANDBOX_NETWORK'] ?? 'minicoder-coder-sandbox',
          dockerHost: process.env['CODER_SANDBOX_DOCKER_HOST'],
          httpsProxy: process.env['CODER_SANDBOX_HTTPS_PROXY'],
        }),
    });
  };
}

// Defaults approximate gpt-4o-mini-class pricing; override via env for the configured provider/model.
// This is a simplification (per-model pricing tables are Phase 16 observability scope) — see the
// costExtractor call site above.
const DEFAULT_PRICE_PER_1K_INPUT_TOKENS = 0.00015;
const DEFAULT_PRICE_PER_1K_OUTPUT_TOKENS = 0.0006;

const CODER_PROMPT_TEMPLATE_VERSION = 'coder-v1';

// MEDIUM-1 code-review fix (round 3): a blank/whitespace-only override must not silently degrade
// run provenance to an empty string — fall back to the default, same posture as parsePriceEnvVar.
function resolvePromptTemplateVersion(): string {
  const raw = process.env['CODER_PROMPT_TEMPLATE_VERSION'];
  if (raw === undefined) return CODER_PROMPT_TEMPLATE_VERSION;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : CODER_PROMPT_TEMPLATE_VERSION;
}

// MEDIUM-3 code-review fix (round 2, hardened round 3): a malformed, negative, non-finite, or
// blank/whitespace-only pricing env var must never silently poison a persisted cost_records row —
// fall back to the default (with a logged warning) instead. `Number('')`/`Number('   ')` both
// evaluate to `0`, which would otherwise be silently accepted as a valid (if unlikely) real price;
// trimming and explicitly rejecting the empty string closes that gap.
function parsePriceEnvVar(envVarName: string, fallback: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`run-coder: ${envVarName} is set but blank; falling back to ${fallback}`);
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    // eslint-disable-next-line no-console
    console.error(
      `run-coder: ${envVarName}="${raw}" is not a finite, non-negative number; falling back to ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

function computeCostUsd(inputTokens: number, outputTokens: number): number {
  const pricePerKInput = parsePriceEnvVar(
    'CODE_GEN_PRICE_PER_1K_INPUT_TOKENS',
    DEFAULT_PRICE_PER_1K_INPUT_TOKENS,
  );
  const pricePerKOutput = parsePriceEnvVar(
    'CODE_GEN_PRICE_PER_1K_OUTPUT_TOKENS',
    DEFAULT_PRICE_PER_1K_OUTPUT_TOKENS,
  );
  return (inputTokens / 1000) * pricePerKInput + (outputTokens / 1000) * pricePerKOutput;
}

interface RepositoryRow {
  owner: string;
  name: string;
  default_branch: string;
}

interface FeatureRunRow {
  id: string;
  feature_request_id: string;
  version: number;
  current_execution_state: string;
}

interface FeatureRequestRow {
  title: string;
  fr_id: string;
}

export interface RunCoderDeps {
  readonly coderAdapterFactory?: CoderAdapterFactory;
  readonly githubClientFactory?: GithubClientFactory;
}

/**
 * Bridges the `coding` state to a real coder-adapter invocation and back into the state machine
 * (docs/06 Phase 9): resolves the active `CoderAgentAdapter` via `AdapterRegistry` (never imports
 * `CodexCoderAdapter` directly — the caller/default-factory does, this file does not), invokes it
 * through `AgentRunRecorder` (recording the context pack, cost/token usage, and tool-operation
 * provenance), dispatches `RecordCodePushedCommand`, then opens a pull request. A separate,
 * independently scheduled/triggered task from `start-next-feature.ts` — see CLAUDE.md's
 * Reference Coder Adapter Operational Constraints for why. Dependencies are bundled into one
 * `deps` object (rather than separate positional params) so `MockTriggerRunner.run`'s single
 * `extra` slot can inject both at once in tests.
 */
export async function runImpl(
  payload: RunCoderPayload,
  db: DbClient,
  deps: RunCoderDeps = {},
): Promise<RunCoderResult> {
  const coderAdapterFactory = deps.coderAdapterFactory ?? resolveDefaultCoderAdapterFactory();
  const githubClientFactory = deps.githubClientFactory ?? resolveDefaultGithubClientFactory();
  const { projectId, featureRunId, correlationId, coderAdapterName } = payload;

  const runRows = await db.query<FeatureRunRow>(
    `SELECT fr.id, fr.feature_request_id, fr.version, fr.current_execution_state
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE fr.id = ? AND freq.project_id = ?`,
    [featureRunId, projectId],
  );
  const run = runRows[0];
  // Phase 10: widened from CODING-only to also accept FIXING — a fix-cycle re-entry
  // (changes_requested -> fixing) reuses this same task/handler, per the matrix's
  // fixing -> code_pushed row (RecordCodePushedCommand, same idempotency key template as
  // coding -> code_pushed; StateTransitionValidator resolves the right matrix row automatically).
  if (
    !run ||
    (run.current_execution_state !== FeatureExecutionState.CODING &&
      run.current_execution_state !== FeatureExecutionState.FIXING)
  ) {
    return { projectId, featureRunId, pushed: false, prNumber: null };
  }
  const isFixCycle = run.current_execution_state === FeatureExecutionState.FIXING;

  const featureRows = await db.query<FeatureRequestRow>(
    `SELECT title, fr_id FROM feature_requests WHERE id = ?`,
    [run.feature_request_id],
  );
  const acceptanceRows = await db.query<{ description: string }>(
    `SELECT description FROM acceptance_criteria WHERE feature_request_id = ? ORDER BY order_index ASC`,
    [run.feature_request_id],
  );
  const repoRows = await db.query<RepositoryRow>(
    `SELECT owner, name, default_branch FROM repositories WHERE project_id = ? LIMIT 1`,
    [projectId],
  );
  const repo = repoRows[0];
  const feature = featureRows[0];
  if (!repo || !feature) {
    return { projectId, featureRunId, pushed: false, prNumber: null };
  }
  const repoUrl = `https://github.com/${repo.owner}/${repo.name}.git`;

  // Phase 16 pre-flight budget forecast (docs/01 §5.11 "Forecast before run"): opt-in via
  // CODE_GEN_ESTIMATED_COST_USD — a no-op (always proceeds) unless a deployment configures it.
  // Runs BEFORE the coder adapter is invoked, so a forecasted hard breach skips the (possibly
  // expensive) LLM call entirely rather than only detecting the breach after paying for it. Does
  // NOT replace the retrospective evaluateBudget()/applyBudgetDecision() check that runs after
  // real cost is recorded — see budget-preflight.ts's doc comment.
  const preflight = await budgetPreflightCheck(db, {
    projectId,
    featureRequestId: run.feature_request_id,
    scope: 'feature',
    correlationId,
    estimatedCostUsd: resolveEstimatedCostUsd('CODE_GEN_ESTIMATED_COST_USD'),
    featureRunId,
  });
  if (!preflight.proceed) {
    return { projectId, featureRunId, pushed: false, prNumber: null };
  }

  // Phase 10: unresolved review_findings for this feature run, folded into CoderInput.openFindings
  // for a fix-cycle invocation only — a first-pass `coding` run has no findings yet.
  // HIGH code-review fix (round 3): `resolved = FALSE`, not `= 0` — see write-findings.ts's
  // comment on why a bare integer literal against a PostgreSQL BOOLEAN column fails.
  const openFindingRows = isFixCycle
    ? await db.query<{ id: string; description: string }>(
        `SELECT id, description FROM review_findings WHERE feature_run_id = ? AND resolved = FALSE`,
        [featureRunId],
      )
    : [];

  const registry = new AdapterRegistry(db);
  const recorder = new AgentRunRecorder(db, registry);
  const adapterRecord = await registry.resolve(AgentRole.CODER, coderAdapterName);
  const adapter = await coderAdapterFactory(repoUrl);

  const input: CoderInput = {
    projectId,
    featureRunId,
    featureTitle: feature.title,
    acceptanceCriteria: acceptanceRows.map((r) => r.description),
    correlationId,
    openFindings: openFindingRows.length > 0 ? openFindingRows : undefined,
  };

  const { agentRunId, output } = await recorder.record(
    {
      adapterId: adapterRecord.id,
      role: AgentRole.CODER,
      projectId,
      featureRunId,
      featureRequestId: run.feature_request_id,
      input,
      capabilitiesUsed: ['can_modify_files', 'can_commit', 'can_push_branch'],
      contextPack: { content: input },
      // MEDIUM-1 code-review fix (round 2): AgentRunRecorder persists promptTemplateVersion when
      // supplied, but this call site never passed one, so the column stayed NULL for every real
      // coder run despite the fix proving out fine for synthetic/test calls.
      promptTemplateVersion: resolvePromptTemplateVersion(),
      costExtractor: (outcome) => {
        if (!outcome.ok) return null;
        const out = outcome.output as { tokensUsed?: { input: number; output: number } };
        if (!out.tokensUsed) return null;
        return {
          inputTokens: out.tokensUsed.input,
          outputTokens: out.tokensUsed.output,
          // HIGH-5 code-review fix: without a costUsd, AgentRunRecorder.insertCostRecord() never
          // writes a cost_records row, so budget gates summing cost_records would see zero spend
          // for every coder run. computeCostUsd() derives a dollar figure from token counts using
          // a configurable per-1K-token price (env-configured, defaulting to gpt-4o-mini-class
          // pricing) — a simplification (real per-model pricing tables are Phase 16 observability
          // scope), but non-zero and budget-gate-visible rather than silently absent.
          costUsd: computeCostUsd(out.tokensUsed.input, out.tokensUsed.output),
          provider: process.env['CODE_GEN_PROVIDER_NAME'] ?? 'openai-compatible',
          model: process.env['CODE_GEN_MODEL'],
        };
      },
      toolOperationsExtractor: (outcome) => {
        if (!outcome.ok) return null;
        const out = outcome.output as {
          toolOperations?: Array<{ toolName: string; status: string; durationMs: number }>;
        };
        return out.toolOperations?.map((op) => ({
          toolName: op.toolName,
          status: op.status,
          durationMs: op.durationMs,
        }));
      },
    },
    () => adapter.run(input),
  );

  const executor = new TransactionalCommandExecutor(db);
  const lane = new ExecutionLane(db);
  let lock: AcquiredLock;
  try {
    lock = await lane.acquireForProject(projectId, 'run-coder-task', EXECUTION_LANE_TTL_MS);
  } catch (err) {
    if (isTransientRace(err)) {
      return { projectId, featureRunId, pushed: false, prNumber: null };
    }
    throw err;
  }

  try {
    const versionRows = await db.query<{ version: number }>(
      `SELECT version FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    const expectedVersion = versionRows[0]?.version ?? run.version;

    const recordPayload = {
      featureRunId,
      projectId,
      expectedVersion,
      commitSha: output.commitSha,
      branchName: output.branchName,
      filesChanged: output.filesChanged,
      // HIGH-2 code-review fix (round 2): pass these through so RecordCodePushedHandler writes
      // the coder_responses rows and resolves findings in the SAME transaction as the state
      // transition, instead of a separate follow-up write after the transaction commits (a crash
      // in between used to strand resolved-in-practice findings as open forever, since a retry
      // no-ops once the run is no longer coding/fixing).
      coderRunId: isFixCycle && openFindingRows.length > 0 ? agentRunId : undefined,
      resolvedFindingIds:
        isFixCycle && openFindingRows.length > 0 ? openFindingRows.map((f) => f.id) : undefined,
    };
    const envelope: CommandEnvelope<typeof recordPayload> = {
      commandId: generateId(),
      idempotencyKey: `record-code-pushed:${featureRunId}:${output.commitSha}`,
      payload: recordPayload,
      actor: systemActor(correlationId),
      correlationId,
      lockContext: {
        lockId: lock.lockId,
        fence: lock.fence,
        holderId: lock.holderId,
        projectId,
        resourceKey: lock.resourceKey,
      },
    };
    await executor.execute(recordCodePushedHandler, envelope);
  } catch (err) {
    if (isTransientRace(err)) {
      return { projectId, featureRunId, pushed: false, prNumber: null };
    }
    throw err;
  } finally {
    await lane.releaseForProject(lock);
  }

  // Phase 10 "optimistic fixed" simplification: a successful fix-cycle push writes one
  // coder_responses row (response_type='fixed') per currently-unresolved review_findings row on
  // this feature run, and marks each resolved. CoderOutput (the shared, Phase-5-vintage adapter
  // contract) carries no per-finding disposition today — a repeat_finding-style reviewer behavior
  // on the *next* review cycle inserts a NEW review_findings row (a new review_cycle) if the issue
  // truly wasn't fixed, preserving history rather than reopening/re-flagging this resolved one.
  // HIGH-2 code-review fix (round 2): this write now happens inside RecordCodePushedHandler's own
  // transaction (via the coderRunId/resolvedFindingIds payload fields above), not as a separate
  // follow-up step here — a crash between the state transition and a standalone follow-up write
  // used to leave findings stranded as unresolved even though the fix had already landed.

  // A PR-creation failure here is a non-fatal, logged side effect: the coder's work is already
  // durably recorded as code_pushed. Reconciliation or a human can retry PR creation later — it
  // must not roll back or re-throw past the already-committed state transition above.
  let prNumber: number | null = null;
  try {
    const client = await githubClientFactory();
    const created = await client.createPullRequest({
      owner: repo.owner,
      repo: repo.name,
      branchName: output.branchName,
      // HIGH-6 code-review fix: use the repository's actual default branch (repositories.
      // default_branch) rather than a hardcoded 'main' — repos using master/develop/etc. would
      // otherwise get PRs opened against the wrong base.
      baseBranch: repo.default_branch,
      title: `${feature.fr_id}: ${feature.title}`,
    });
    prNumber = created.prNumber;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `run-coder: pull request creation failed for ${featureRunId} after a successful push; ` +
        'a later reconciliation pass or a human can retry it',
      err,
    );
  }

  return { projectId, featureRunId, pushed: true, prNumber };
}
