import {
  AdapterRegistry,
  AgentRole,
  AgentRunRecorder,
  EscalateToHumanHandler,
  FeatureExecutionState,
  FindingSeverity,
  FIX_ATTEMPT_THRESHOLD,
  RecordChangesRequestedHandler,
  StartFixingHandler,
  TransactionalCommandExecutor,
  generateId,
  normalizeReviewerFindings,
  insertReviewFindings,
  findReviewOccurrenceMarker,
  recordReviewOccurrenceMarker,
  findRepeatedFinding,
  insertDisagreementRecord,
  recordArbiterDisposition,
  defaultRedactor,
  isoNow,
} from '@minicoder/core';
import type {
  ArbiterAgentAdapter,
  ArbiterInput,
  CommandEnvelope,
  DbClient,
  GitHubClient,
  ReviewerAgentAdapter,
  ReviewerInput,
  ReviewFindingInsert,
} from '@minicoder/core';
import { ExecutionLane } from '@minicoder/workflow';
import type { AcquiredLock } from '@minicoder/workflow';
import type { RunReviewPayload } from './types.js';
import { systemActor } from './actor.js';
import { isTransientRace as isTransientRaceShared } from './transient-race.js';
import { requireNonBlankEnvVar } from './env.js';

export type { RunReviewPayload };

export interface RunReviewResult {
  projectId: string;
  featureRunId: string;
  /** True only when THIS invocation actually invoked a `ReviewerAgentAdapter`/`ArbiterAgentAdapter`
   * and produced a fresh outcome — false for every short-circuit path (no matching feature run,
   * wrong current state, no tracked PR, or — per issue #46 — a prior-occurrence-marker hit for the
   * same PR head commit). `reviewed: false, decision: 'approved'` specifically means "this exact
   * commit was already reviewed and found clean by an earlier invocation; nothing new happened
   * here," not "this commit has no review coverage." Do not read `reviewed` as "is this commit
   * covered by review" — check `review_occurrence_markers`/`review_findings` for that. */
  reviewed: boolean;
  decision: 'approved' | 'changes_requested' | 'escalated' | null;
}

const recordChangesRequestedHandler = new RecordChangesRequestedHandler();
const escalateToHumanHandler = new EscalateToHumanHandler();
const startFixingHandler = new StartFixingHandler();
const EXECUTION_LANE_TTL_MS = 30_000;

// This task never attempts SelectFeature/StartCoding-style transitions; only an in-flight
// idempotency-key race with a concurrent invocation of this same task, or the feature run
// vanishing underneath us, are expected non-fatal races (mirrors run-coder.ts's narrower set).
// 'automation-paused' is included too (issue #48): advanceToFixing()'s StartFixingCommand
// dispatch can throw it if automation is paused at that exact moment, and
// github-reconciliation.ts already treats the identical condition on the identical command as an
// expected, swallowed race rather than a task failure — the two callers of StartFixingCommand
// should behave the same way for the same underlying condition. The changes_requested transition
// this function guards is already durably recorded by the time StartFixingCommand is attempted,
// so swallowing this here loses nothing: a later github-reconciliation pass (or another
// run-review invocation) picks up the `-> fixing` hop once automation resumes.
const EXPECTED_COMMAND_ERROR_TYPES = new Set([
  'concurrent-command',
  'not-found',
  'automation-paused',
]);

function isTransientRace(err: unknown): boolean {
  return isTransientRaceShared(err, EXPECTED_COMMAND_ERROR_TYPES);
}

/** Builds a fresh `ArbiterAgentAdapter` instance for a single disagreement resolution. A caller can
 * still inject a custom factory via `RunReviewDeps` (e.g. a test double, or a distinct
 * arbiter model/endpoint); when none is supplied, `resolveDefaultArbiterAdapterFactory()`
 * constructs the real reference `ClaudeArbiterAdapter` (issue #51). */
export type ArbiterAdapterFactory = () => Promise<ArbiterAgentAdapter>;

/**
 * Constructs the real reference `ClaudeArbiterAdapter` (issue #51) from env config. Deliberately
 * reuses the same `CODE_GEN_BASE_URL`/`CODE_GEN_API_KEY`/`CODE_GEN_MODEL` env vars the
 * Coder/Reviewer/Planner default resolvers already use — simpler than introducing a parallel
 * `ARBITER_*` env-var family when the same OpenAI-compatible endpoint can serve all four roles. A
 * deployment wanting a distinct arbiter model/endpoint can still inject a custom
 * `ArbiterAdapterFactory` via `RunReviewDeps` instead of using this default.
 */
function resolveDefaultArbiterAdapterFactory(): ArbiterAdapterFactory {
  return async () => {
    const codeGenBaseUrl = requireNonBlankEnvVar(
      'CODE_GEN_BASE_URL',
      'run-review requires an OpenAI-compatible endpoint to arbitrate a disagreement — see ' +
        'docs/07-security-and-secrets.md §3.',
    );
    const codeGenApiKey = requireNonBlankEnvVar(
      'CODE_GEN_API_KEY',
      'run-review requires an OpenAI-compatible endpoint to arbitrate a disagreement — see ' +
        'docs/07-security-and-secrets.md §3.',
    );
    const codeGenModel = requireNonBlankEnvVar(
      'CODE_GEN_MODEL',
      'run-review requires an OpenAI-compatible endpoint to arbitrate a disagreement — see ' +
        'docs/07-security-and-secrets.md §3.',
    );
    const { ClaudeArbiterAdapter, HttpArbiterProvider } =
      await import('@minicoder/adapters-arbiter');
    return new ClaudeArbiterAdapter({
      arbiterProvider: new HttpArbiterProvider({
        baseUrl: codeGenBaseUrl,
        apiKey: codeGenApiKey,
        model: codeGenModel,
      }),
    });
  };
}

export type GithubClientFactory = () => Promise<GitHubClient>;
/** Builds a fresh `ReviewerAgentAdapter` instance for this one run, given the project's repo
 * owner/repo — a factory (not a singleton) because one deployment can serve multiple projects
 * with different GitHub repos, and `ReviewerInput` itself carries no repo/credential fields,
 * mirroring `CoderAdapterFactory` in run-coder.ts (docs/06 Phase 10). */
export type ReviewerAdapterFactory = (opts: {
  owner: string;
  repo: string;
  githubClient: GitHubClient;
}) => Promise<ReviewerAgentAdapter>;

function resolveDefaultGithubClientFactory(): GithubClientFactory {
  return async () => {
    const token = requireNonBlankEnvVar(
      'GITHUB_TOKEN',
      'run-review requires a GitHub credential (GitHub App installation token or PAT) to fetch ' +
        'the pull request diff — see docs/07-security-and-secrets.md §3.',
    );
    const { OctokitGitHubClient } = await import('@minicoder/github');
    return new OctokitGitHubClient({ auth: token });
  };
}

/**
 * Constructs the real reference `ClaudeReviewerAdapter` from env config. Deliberately reuses the
 * same `CODE_GEN_BASE_URL`/`CODE_GEN_API_KEY`/`CODE_GEN_MODEL` env vars run-coder.ts uses for code
 * generation — simpler than introducing a parallel `REVIEW_*` env-var family when the same
 * OpenAI-compatible endpoint can serve both roles (docs/06 Phase 10 "Design decisions"). A
 * deployment wanting a distinct reviewer model/endpoint can still inject a custom
 * `ReviewerAdapterFactory` via `RunReviewDeps` instead of using this default.
 */
function resolveDefaultReviewerAdapterFactory(): ReviewerAdapterFactory {
  return async ({ owner, repo, githubClient }) => {
    const codeGenBaseUrl = requireNonBlankEnvVar(
      'CODE_GEN_BASE_URL',
      'run-review requires an OpenAI-compatible endpoint — see docs/07-security-and-secrets.md §3.',
    );
    const codeGenApiKey = requireNonBlankEnvVar(
      'CODE_GEN_API_KEY',
      'run-review requires an OpenAI-compatible endpoint — see docs/07-security-and-secrets.md §3.',
    );
    const codeGenModel = requireNonBlankEnvVar(
      'CODE_GEN_MODEL',
      'run-review requires an OpenAI-compatible endpoint — see docs/07-security-and-secrets.md §3.',
    );
    const { ClaudeReviewerAdapter, HttpReviewProvider } =
      await import('@minicoder/adapters-reviewer');
    return new ClaudeReviewerAdapter({
      owner,
      repo,
      githubClient,
      reviewProvider: new HttpReviewProvider({
        baseUrl: codeGenBaseUrl,
        apiKey: codeGenApiKey,
        model: codeGenModel,
      }),
    });
  };
}

const DEFAULT_PRICE_PER_1K_INPUT_TOKENS = 0.00015;
const DEFAULT_PRICE_PER_1K_OUTPUT_TOKENS = 0.0006;
const REVIEWER_PROMPT_TEMPLATE_VERSION = 'reviewer-v1';

function parsePriceEnvVar(envVarName: string, fallback: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`run-review: ${envVarName} is set but blank; falling back to ${fallback}`);
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    // eslint-disable-next-line no-console
    console.error(
      `run-review: ${envVarName}="${raw}" is not a finite, non-negative number; falling back to ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

function computeCostUsd(inputTokens: number, outputTokens: number): number {
  // Reuses run-coder.ts's CODE_GEN_PRICE_PER_1K_* env vars — same backend, same pricing knobs.
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
}

interface FeatureRunRow {
  id: string;
  feature_request_id: string;
  version: number;
  current_execution_state: string;
  fix_attempt_count: number;
}

interface PullRequestRow {
  pr_number: number;
  head_sha: string | null;
}

export interface RunReviewDeps {
  readonly reviewerAdapterFactory?: ReviewerAdapterFactory;
  readonly githubClientFactory?: GithubClientFactory;
  readonly arbiterAdapterFactory?: ArbiterAdapterFactory;
}

const ARBITER_PROMPT_TEMPLATE_VERSION = 'arbiter-v1';

interface CoderResponseRow {
  response_type: string;
  notes: string | null;
}

/**
 * Best-effort summary of the coder's side of a disagreement, for `ArbiterInput.coderPosition`.
 * `coder_responses` only ever writes an optimistic `'fixed'` disposition today (docs/06 Phase 10's
 * "optimistic fixed" design decision) — there is no real per-finding dispute/acknowledgement text
 * yet — so this is deliberately a plain fallback description, not a claim that the coder actually
 * argued for its position.
 */
async function summarizeCoderPosition(db: DbClient, priorFindingId: string): Promise<string> {
  const rows = await db.query<CoderResponseRow>(
    `SELECT response_type, notes FROM coder_responses WHERE finding_id = ? ORDER BY created_at DESC LIMIT 1`,
    [priorFindingId],
  );
  const row = rows[0];
  if (!row) {
    return 'No coder_responses row on file for the prior occurrence of this finding.';
  }
  return `Coder's last response to this finding was '${row.response_type}'${row.notes ? `: ${row.notes}` : ''}.`;
}

/**
 * Bridges the `under_review` state to a real reviewer-adapter invocation and back into the state
 * machine (docs/06 Phase 10): resolves the active `ReviewerAgentAdapter` via `AdapterRegistry`,
 * invokes it through `AgentRunRecorder`, normalizes its output (the single normalization point —
 * see `@minicoder/core`'s `normalizeReviewerFindings()` doc comment), then either (a) passes the
 * findings straight into `RecordChangesRequestedCommand`/`EscalateToHumanCommand`'s payload so
 * they're written atomically with the state transition (HIGH-1 code-review fix, round 2 — a crash
 * between a standalone findings write and the transition used to strand blocking findings against
 * a run that never actually transitioned), or (b) writes them via a standalone
 * `insertReviewFindings()` call when the review is clean (no transition to piggyback on). A
 * separate, independently scheduled/triggered task from `run-coder.ts` and `start-next-feature.ts`
 * (CLAUDE.md's "never inline" rule for GitHub-facing/execution tasks).
 *
 * No `RecordApprovedByPolicyCommand` is dispatched on approval (Phase 12 — Merge Gate — owns that
 * transition); a clean review simply leaves the feature run at `under_review` with its
 * non-blocking findings recorded for audit, satisfying "non-blocking findings do not block merge"
 * because there is no merge gate yet to block.
 */
export async function runImpl(
  payload: RunReviewPayload,
  db: DbClient,
  deps: RunReviewDeps = {},
): Promise<RunReviewResult> {
  const githubClientFactory = deps.githubClientFactory ?? resolveDefaultGithubClientFactory();
  const { projectId, featureRunId, correlationId, reviewerAdapterName, arbiterAdapterName } =
    payload;

  const runRows = await db.query<FeatureRunRow>(
    `SELECT fr.id, fr.feature_request_id, fr.version, fr.current_execution_state, fr.fix_attempt_count
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE fr.id = ? AND freq.project_id = ?`,
    [featureRunId, projectId],
  );
  const run = runRows[0];
  if (!run) {
    return { projectId, featureRunId, reviewed: false, decision: null };
  }

  // HIGH-3 code-review fix (Phase 10 PR review): a prior invocation may have already dispatched
  // RecordChangesRequestedCommand (feature run now at CHANGES_REQUESTED) and then hit a transient
  // lock-conflict/race acquiring the execution lane for StartFixingCommand — returning before that
  // command ran. Because the guard above used to require UNDER_REVIEW, a retry would see
  // CHANGES_REQUESTED and no-op forever, stranding the feature run instead of ever reaching
  // `fixing`. Make this resumable: a feature run already at CHANGES_REQUESTED skips the reviewer
  // invocation entirely (it was already reviewed) and just retries the StartFixingCommand hop.
  if (run.current_execution_state === FeatureExecutionState.CHANGES_REQUESTED) {
    const decision = await advanceToFixing(
      db,
      new TransactionalCommandExecutor(db),
      systemActor(correlationId),
      correlationId,
      projectId,
      featureRunId,
      run.version,
    );
    return { projectId, featureRunId, reviewed: true, decision };
  }

  if (run.current_execution_state !== FeatureExecutionState.UNDER_REVIEW) {
    return { projectId, featureRunId, reviewed: false, decision: null };
  }

  const repoRows = await db.query<RepositoryRow>(
    `SELECT owner, name FROM repositories WHERE project_id = ? LIMIT 1`,
    [projectId],
  );
  const prRows = await db.query<PullRequestRow>(
    `SELECT pr_number, head_sha FROM pull_requests WHERE feature_run_id = ?`,
    [featureRunId],
  );
  const repo = repoRows[0];
  const pr = prRows[0];
  if (!repo || !pr) {
    return { projectId, featureRunId, reviewed: false, decision: null };
  }

  // Issue #46: checked BEFORE invoking the reviewer adapter at all. If this exact PR head commit
  // was already fully reviewed with a clean (approved) outcome, a retry (e.g. a duplicate task
  // trigger, or a crash after the first attempt's clean-review write already committed) must not
  // re-invoke the adapter and mint a new reviewCycle for a commit that's already been reviewed.
  if (pr.head_sha) {
    const priorOccurrence = await findReviewOccurrenceMarker(db, {
      featureRunId,
      headSha: pr.head_sha,
    });
    if (priorOccurrence) {
      return { projectId, featureRunId, reviewed: false, decision: 'approved' };
    }
  }

  const cycleRows = await db.query<{ maxCycle: number | null }>(
    `SELECT MAX(review_cycle) as maxCycle FROM review_findings WHERE feature_run_id = ?`,
    [featureRunId],
  );
  const reviewCycle = (cycleRows[0]?.maxCycle ?? 0) + 1;

  const githubClient = await githubClientFactory();
  const reviewerAdapterFactory =
    deps.reviewerAdapterFactory ?? resolveDefaultReviewerAdapterFactory();

  const registry = new AdapterRegistry(db);
  const recorder = new AgentRunRecorder(db, registry);
  const adapterRecord = await registry.resolve(AgentRole.REVIEWER, reviewerAdapterName);
  const adapter = await reviewerAdapterFactory({
    owner: repo.owner,
    repo: repo.name,
    githubClient,
  });

  // Issue #47: the same feature title / acceptance criteria query run-coder.ts already uses, so
  // the reviewer can check the diff against the real acceptance criteria instead of a synthesized
  // placeholder.
  const featureRows = await db.query<{ title: string }>(
    `SELECT title FROM feature_requests WHERE id = ?`,
    [run.feature_request_id],
  );
  const acceptanceRows = await db.query<{ description: string }>(
    `SELECT description FROM acceptance_criteria WHERE feature_request_id = ? ORDER BY order_index ASC`,
    [run.feature_request_id],
  );

  const input: ReviewerInput = {
    projectId,
    featureRunId,
    prNumber: pr.pr_number,
    reviewCycle,
    correlationId,
    featureTitle: featureRows[0]?.title,
    acceptanceCriteria: acceptanceRows.map((r) => r.description),
  };

  const { agentRunId, output } = await recorder.record(
    {
      adapterId: adapterRecord.id,
      role: AgentRole.REVIEWER,
      projectId,
      featureRunId,
      featureRequestId: run.feature_request_id,
      input,
      capabilitiesUsed: ['can_review_pull_request', 'can_return_structured_findings'],
      contextPack: { content: input },
      promptTemplateVersion: REVIEWER_PROMPT_TEMPLATE_VERSION,
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
    () => adapter.run(input),
  );

  // Issue #49: persist a replayable snapshot of the exact prompt sent to the reviewer LLM (if the
  // adapter reports one — MockReviewerAdapter and other test doubles don't), plus the PR head SHA
  // as the "which diff" reference (avoids duplicating the diff itself; a commit reference is
  // already sufficient to identify it). Written as a second agent_context_packs row (distinct
  // content_schema_version) keyed to the same agentRunId, applying the same redaction convention
  // AgentRunRecorder's own context-pack write already uses — this one is written directly since
  // it's only knowable after the adapter call returns, while AgentRunRecorder's own contextPack
  // option is written before the call.
  const reviewerPromptSnapshot = (output as { promptSnapshot?: unknown }).promptSnapshot;
  if (reviewerPromptSnapshot !== undefined) {
    const now = isoNow();
    await db.execute(
      `INSERT INTO agent_context_packs (id, agent_run_id, content, content_schema_version, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [
        generateId(),
        agentRunId,
        JSON.stringify(
          defaultRedactor.redactObject({
            promptSnapshot: reviewerPromptSnapshot,
            headSha: pr.head_sha,
          }),
        ),
        'reviewer-prompt-snapshot-v1',
        now,
        now,
      ],
    );
  }

  // Single normalization point (Phase 10 design decision): every adapter (ClaudeReviewerAdapter
  // or a test MockReviewerAdapter) returns a raw ReviewerOutput; this is the one place that
  // validates/shapes it into insert-ready ReviewFindingInsert rows.
  const findings: ReviewFindingInsert[] = normalizeReviewerFindings(output);

  const executor = new TransactionalCommandExecutor(db);
  const actor = systemActor(correlationId);

  const hasRequiresHumanDecision = findings.some(
    (f) => f.severity === FindingSeverity.REQUIRES_HUMAN_DECISION,
  );
  const hasBlocking = findings.some((f) => f.severity === FindingSeverity.BLOCKING);

  // HIGH-1 code-review fix (round 2): findings used to be written unconditionally *before* this
  // branch, in their own transaction separate from whichever state transition follows. A crash in
  // that window left blocking/requires_human_decision findings recorded against a run that never
  // actually transitioned, and a retry would recompute reviewCycle = MAX(review_cycle) + 1,
  // re-invoke the reviewer, and write a redundant cycle on top. Now the blocking/escalation paths
  // pass `findings`/`reviewerRunId`/`reviewCycle` straight into the command payload so
  // RecordChangesRequestedHandler/EscalateToHumanHandler write them in the SAME transaction as the
  // state transition (fully atomic — either both commit or neither does). Only the "approved, no
  // transition to piggyback on" path below still writes findings as a standalone call.
  if (hasRequiresHumanDecision) {
    await dispatchEscalation(executor, actor, correlationId, projectId, featureRunId, run.version, {
      reviewerRunId: agentRunId,
      reviewCycle,
      findings,
    });
    return { projectId, featureRunId, reviewed: true, decision: 'escalated' };
  }

  if (hasBlocking) {
    if (run.fix_attempt_count >= FIX_ATTEMPT_THRESHOLD) {
      await dispatchEscalation(
        executor,
        actor,
        correlationId,
        projectId,
        featureRunId,
        run.version,
        { reviewerRunId: agentRunId, reviewCycle, findings },
      );
      return { projectId, featureRunId, reviewed: true, decision: 'escalated' };
    }

    // Phase 11: disagreement detection. The same blocking finding recurring across review cycles
    // means the coder's prior fix attempt didn't actually satisfy the reviewer — a genuine
    // coder/reviewer disagreement, not a normal one-shot fix cycle — so route it through the
    // ArbiterAgentAdapter before falling back to the ordinary changes_requested path.
    let effectiveFindings = findings;
    const repeated = await findRepeatedFinding(db, { featureRunId, reviewCycle, findings });
    if (repeated) {
      if (!arbiterAdapterName) {
        throw new Error(
          'run-review detected a repeated unresolved finding (a coder/reviewer disagreement) but no ' +
            'arbiterAdapterName was configured on the payload — an ArbiterAgentAdapter must be ' +
            'registered (e.g. ClaudeArbiterAdapter, issue #51) and named here before arbitration ' +
            'can proceed.',
        );
      }
      const arbiterAdapterFactory =
        deps.arbiterAdapterFactory ?? resolveDefaultArbiterAdapterFactory();
      const disagreementId = await insertDisagreementRecord(db, {
        featureRunId,
        findingId: repeated.priorFindingId,
        reviewCycle,
      });
      const arbiterRegistry = new AdapterRegistry(db);
      const arbiterAdapterRecord = await arbiterRegistry.resolve(
        AgentRole.ARBITER,
        arbiterAdapterName,
      );
      const arbiterAdapter = await arbiterAdapterFactory();
      const arbiterInput: ArbiterInput = {
        projectId,
        featureRunId,
        findingDescription: repeated.description,
        coderPosition: await summarizeCoderPosition(db, repeated.priorFindingId),
        reviewerPosition: repeated.description,
        correlationId,
      };
      const { agentRunId: arbiterRunId, output: arbiterOutput } = await recorder.record(
        {
          adapterId: arbiterAdapterRecord.id,
          role: AgentRole.ARBITER,
          projectId,
          featureRunId,
          featureRequestId: run.feature_request_id,
          input: arbiterInput,
          capabilitiesUsed: ['can_resolve_disagreement'],
          contextPack: { content: arbiterInput },
          promptTemplateVersion: ARBITER_PROMPT_TEMPLATE_VERSION,
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
        () => arbiterAdapter.run(arbiterInput),
      );

      if (arbiterOutput.resolution === 'escalate_to_human') {
        await recordArbiterDisposition(db, {
          disagreementId,
          arbiterRunId,
          state: 'escalated',
          resolution: arbiterOutput.notes,
        });
        await dispatchEscalation(
          executor,
          actor,
          correlationId,
          projectId,
          featureRunId,
          run.version,
          { reviewerRunId: agentRunId, reviewCycle, findings },
        );
        return { projectId, featureRunId, reviewed: true, decision: 'escalated' };
      }

      await recordArbiterDisposition(db, {
        disagreementId,
        arbiterRunId,
        state: 'resolved',
        resolution: arbiterOutput.notes,
      });
      if (arbiterOutput.resolution === 'coder_correct') {
        // The Arbiter sided with the coder: this finding is dismissed, not a real defect.
        // Downgrade it to non_blocking rather than dropping it, so the disagreement stays
        // auditable in review_findings.
        effectiveFindings = findings.map((f) =>
          f.description.trim() === repeated.description.trim() &&
          (f.severity === FindingSeverity.BLOCKING ||
            f.severity === FindingSeverity.REQUIRES_HUMAN_DECISION)
            ? { ...f, severity: FindingSeverity.NON_BLOCKING }
            : f,
        );
      }
      // 'reviewer_correct' / 'compromise': the finding stands, proceed to the normal fix loop
      // below with `findings` unchanged.
    }

    const stillBlocking = effectiveFindings.some((f) => f.severity === FindingSeverity.BLOCKING);
    if (!stillBlocking) {
      // The Arbiter dismissed every blocking finding this cycle; nothing left to request changes
      // for. Record the (now downgraded) findings for audit and stay at under_review, same as the
      // plain "no blocking findings" path below. Issue #46: the findings write and the occurrence
      // marker commit atomically together, so a crash between them can't leave one without the
      // other, and a retry's pre-adapter marker check (above) will find this recorded.
      await db.transaction(async (tx) => {
        await insertReviewFindings(tx, {
          featureRunId,
          reviewerRunId: agentRunId,
          reviewCycle,
          findings: effectiveFindings,
        });
        if (pr.head_sha) {
          await recordReviewOccurrenceMarker(tx, {
            featureRunId,
            headSha: pr.head_sha,
            reviewCycle,
            outcome: 'approved',
          });
        }
      });
      return { projectId, featureRunId, reviewed: true, decision: 'approved' };
    }

    const reviewId = `review-${featureRunId}-${reviewCycle}`;
    let changesRequestedVersion: number;
    try {
      const envelope: CommandEnvelope<Record<string, unknown>> = {
        commandId: generateId(),
        idempotencyKey: `changes-requested:${featureRunId}:${reviewId}`,
        payload: {
          featureRunId,
          projectId,
          expectedVersion: run.version,
          reviewId,
          reviewerRunId: agentRunId,
          reviewCycle,
          findings: effectiveFindings,
        },
        actor,
        correlationId,
      };
      await executor.execute(recordChangesRequestedHandler, envelope);
      const versionRows = await db.query<{ version: number }>(
        `SELECT version FROM feature_runs WHERE id = ?`,
        [featureRunId],
      );
      changesRequestedVersion = versionRows[0]?.version ?? run.version + 1;
    } catch (err) {
      if (isTransientRace(err)) {
        return { projectId, featureRunId, reviewed: false, decision: null };
      }
      throw err;
    }

    const decision = await advanceToFixing(
      db,
      executor,
      actor,
      correlationId,
      projectId,
      featureRunId,
      changesRequestedVersion,
    );
    return { projectId, featureRunId, reviewed: true, decision };
  }

  // Only non_blocking/nit/question/out_of_scope findings (or none at all) — no transition to
  // piggyback the write on, so this is the one path that still writes findings as a standalone
  // call; the feature run stays at under_review (Phase 12's Merge Gate owns the next hop). Issue
  // #46: the findings write and the occurrence marker commit atomically in one transaction, and a
  // retry's pre-adapter marker check (above) finds this recorded instead of re-invoking the
  // adapter and minting a new reviewCycle for an already-reviewed commit.
  await db.transaction(async (tx) => {
    await insertReviewFindings(tx, {
      featureRunId,
      reviewerRunId: agentRunId,
      reviewCycle,
      findings,
    });
    if (pr.head_sha) {
      await recordReviewOccurrenceMarker(tx, {
        featureRunId,
        headSha: pr.head_sha,
        reviewCycle,
        outcome: 'approved',
      });
    }
  });
  return { projectId, featureRunId, reviewed: true, decision: 'approved' };
}

/**
 * changes_requested -> fixing. Extracted so both the fresh-review path (right after
 * RecordChangesRequestedCommand succeeds) and a resumed retry (a feature run already at
 * CHANGES_REQUESTED from a prior invocation that stalled before this step — HIGH-3 code-review
 * fix) share one implementation. `expectedVersion` must be the feature run's *current* version at
 * CHANGES_REQUESTED, refetched by the caller. Always returns 'changes_requested': the review
 * outcome is already durably recorded regardless of whether this hop itself completes or hits a
 * transient race (a later retry — either another run-review invocation landing on the
 * CHANGES_REQUESTED branch above, or another mechanism — will complete it).
 */
async function advanceToFixing(
  db: DbClient,
  executor: TransactionalCommandExecutor,
  actor: ReturnType<typeof systemActor>,
  correlationId: string,
  projectId: string,
  featureRunId: string,
  expectedVersion: number,
): Promise<'changes_requested'> {
  // StartFixingCommand needs the execution-lane lock (unlike RecordChangesRequestedCommand),
  // mirroring run-coder.ts's ExecutionLane acquire/release/isTransientRace pattern.
  const lane = new ExecutionLane(db);
  let lock: AcquiredLock;
  try {
    lock = await lane.acquireForProject(projectId, 'run-review-task', EXECUTION_LANE_TTL_MS);
  } catch (err) {
    if (isTransientRace(err)) {
      return 'changes_requested';
    }
    throw err;
  }
  try {
    const startFixingEnvelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `start-fixing:${featureRunId}:${expectedVersion}`,
      payload: { featureRunId, projectId, expectedVersion },
      actor,
      correlationId,
      lockContext: {
        lockId: lock.lockId,
        fence: lock.fence,
        holderId: lock.holderId,
        projectId,
        resourceKey: lock.resourceKey,
      },
    };
    await executor.execute(startFixingHandler, startFixingEnvelope);
  } catch (err) {
    if (!isTransientRace(err)) throw err;
  } finally {
    await lane.releaseForProject(lock);
  }
  return 'changes_requested';
}

async function dispatchEscalation(
  executor: TransactionalCommandExecutor,
  actor: ReturnType<typeof systemActor>,
  correlationId: string,
  projectId: string,
  featureRunId: string,
  expectedVersion: number,
  findingsContext?: {
    reviewerRunId: string;
    reviewCycle: number;
    findings: ReviewFindingInsert[];
  },
): Promise<void> {
  const envelope: CommandEnvelope<Record<string, unknown>> = {
    commandId: generateId(),
    idempotencyKey: `escalate-human-review:${featureRunId}`,
    payload: {
      featureRunId,
      projectId,
      expectedVersion,
      reason:
        'Reviewer produced a requires_human_decision finding or exceeded the fix-attempt threshold',
      ...(findingsContext
        ? {
            reviewerRunId: findingsContext.reviewerRunId,
            reviewCycle: findingsContext.reviewCycle,
            findings: findingsContext.findings,
          }
        : {}),
    },
    actor,
    correlationId,
  };
  await executor.execute(escalateToHumanHandler, envelope);
}
