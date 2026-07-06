# MiniCoder — Claude Code Project Guide

## What This Repository Is

MiniCoder is an **Agentic Software Development Orchestration System** that converts user intent or
system specifications into a clarified, approved, sequential implementation backlog, then
orchestrates feature-branch development, pull requests, structured reviews, fixes, merge gates,
and final design documentation.

This repository contains the **Phase 1–3 and 5–11 implementation**: monorepo skeleton, persistence
abstraction (SQLite + PostgreSQL), 43-table initial schema, migration tooling, config/secrets
backends, database lifecycle CLI (`minicoder db`), CI (Phase 1); full state-machine / command
layer with state-transition validator, transactional idempotent commands, outbox/inbox dispatching,
workflow locks with fencing tokens, execution lanes, local auth, secret-redaction tests, and the
`minicoder state` CLI (Phase 2); the Workflow Layer harness with a 9-service Trigger.dev v4
Docker Compose stack (`infra/docker-compose.triggerdev.yml`), 9 initial task stubs registered via
`@trigger.dev/sdk/v3`, `assertSchemaReady()` post-connect schema probe, CI/CD deploy workflow
(`.github/workflows/trigger-deploy.yml`), and `minicoder trigger` CLI scaffold (Phase 3); the
Agent Adapter Foundation — the six role interfaces, `AdapterRegistry`, the capability model with
runtime validation, `AgentRunRecorder` with automatic provenance snapshotting, six deterministic
mock adapters (including `HumanTestAdapter`), and the Phase 5 smoke conformance suite (Phase 5,
migrations 0003–0006); and the Bootstrap Planner, Readiness, and Clarification implementation —
specification ingestion, planner-adapter-backed readiness assessment, the clarification workflow
and its circuit breaker, plan and feature-backlog generation and validation (with a
backlog-version-scoped validation gate before approval), approval and activation, and artifact
export/import, with all 15 canonical Trigger.dev task IDs wired to real Orchestrator Core commands
(Phase 6, migrations 0007–0008); and the GitHub Webhooks, Integration, and Reconciliation
implementation — the `packages/github` webhook receiver (HMAC signature verification with
current+previous secret rotation, event normalization, `minicoder github serve`), the
provider-SDK-free `GitHubClient` seam and `OctokitGitHubClient`, the `pull_requests` table, five
new GitHub-facing feature-execution commands, and the shared `reconcileGithubState()` algorithm
driving both webhook-triggered inbox handlers and the scheduled `github-reconciliation` fallback
(Phase 7, migration 0009); and the Execution Orchestrator implementation — the real
`start-next-feature` Trigger.dev task (dependency-ordered feature selection via
`findNextEligibleFeatureRun()`, `SelectFeatureCommand`, and `StartCodingCommand` gated by
`packages/workflow`'s `ExecutionLane`), pause/resume automation control (`ResumeAutomationCommand`),
and the minimal budget-gate primitive (`packages/core/src/cost/`'s `evaluateBudget()`/
`applyBudgetDecision()`, `RecordBudgetExceededCommand`, `RecordBudgetApprovalWaitingCommand`,
`ApproveBudgetOverrideCommand`) (Phase 8, no new migration); and the Reference Coder Adapter
implementation — `packages/adapters-coder`'s `CodexCoderAdapter` (an injected `CodeGenerationProvider`
seam, runner-agnostic git orchestration, bounded-diff/disallowed-path enforcement), real ephemeral
sandbox container isolation (`CoderSandbox` via `dockerode`, `infra/docker-compose.coder-sandbox.yml`'s
egress-allow-list proxy — written but not yet daemon-verified in this repository's CI), the
`run-coder` Trigger.dev task bridging `coding` → adapter invocation → `RecordCodePushedCommand` →
pull-request creation, and `AgentRunRecorder`'s first production writers for `agent_context_packs`,
`agent_tool_operations`, and `cost_records` (Phase 9, migration 0010); the Reference Reviewer
Adapter and Review/Fix Loop implementation — `packages/adapters-reviewer`'s
`ClaudeReviewerAdapter` (a sandbox-free, read-only `ReviewProvider` seam), the `run-review`
Trigger.dev task driving `under_review → changes_requested → fixing` and `ci_failed →
changes_requested → fixing`, the aggregate `feature_runs.fix_attempt_count` circuit breaker
(migration 0011), and `reconcileGithubState()`'s new `changes_requested → fixing` reconciliation
branch (Phase 10); and the Disagreement, Arbiter, and Human Escalation implementation —
`packages/core/src/disagreement`'s repeated-unresolved-finding detection and
`disagreement_records` evidence writers, `run-review.ts`'s inline `ArbiterAgentAdapter` invocation
(no reference implementation shipped; injected only), five new `human_required` exit commands
(`ResolveDisagreementCommand`, `ResumeFeatureExecutionCommand`, `RetryFeatureCommand`,
`SkipFeatureCommand`, `BlockFeatureCommand`) and their `minicoder human ...` CLI surface, the new
terminal `skipped` feature-execution state, and `human_approvals`'s first production writers
(Phase 11, no new migration); and the Merge Gate and Branch Protection implementation — the
`evaluateMergeGate()` merge-policy engine (`packages/core/src/merge-gate/`), the real
`RecordApprovedByPolicyCommand`/`MergeIfReadyCommand`/`RecordMergedCommand`/
`RecordMergeFailedCommand`/`ReconcileMergeFailedCommand` handlers (matrix rows defined since
Phase 2, given real handlers here), `GitHubClient.mergePullRequest()` and the first production
caller of `GitHubClient.publishStatusCheck()` (the `minicoder/review-gate` status check), the new
`run-merge-gate` Trigger.dev task, and the `minicoder merge merge-if-ready` CLI command (Phase 12,
no new migration — `merge_gate_evaluations` and `pull_requests` already existed).
Canonical specification documents live under `docs/`.

## Repository Structure

```
README.md                                # Non-authoritative summary + doc map
CLAUDE.md                                # This file
docs/
  00-glossary-and-terms.md              # CANONICAL: states, roles, adapters, CLI, tech stack
  01-system-specification.md            # CANONICAL: architecture, data design, API, merge policy
  02-bootstrap-planner-clarification.md # CANONICAL: planning, readiness, clarification workflow
  03-agent-adapter-architecture.md      # CANONICAL: adapter roles, conformance, execution contract
  04-testing-validation-state-lifecycle.md # CANONICAL: testing, lifecycle tooling, runbooks
  05-ui-specification.md                # CANONICAL: TUI + Web UI specs
  06-implementation-plan.md             # CANONICAL: 18-phase implementation plan
  07-security-and-secrets.md            # CANONICAL: secrets, auth, sandboxing, payload hygiene
```

**Precedence rule:** Everything under `docs/` is canonical. If `README.md` prose and a `docs/` file
disagree, the `docs/` file wins. Within `docs/`, shared vocabulary is defined once in
`00-glossary-and-terms.md`; other files reference it.

## Development Branch

Each session works on a dedicated PR branch specified in the session system prompt. Always
push with:

```bash
git push -u origin <branch-from-session-prompt>
```

Never push directly to `main`.

## Key Architectural Decisions (Do Not Change Without Explicit Instruction)

These are locked decisions that appear throughout the docs. Do not contradict or soften them:

1. **One architecture, two state-store profiles.** SQLite = local/single-node; PostgreSQL =
   hosted/team. Both are in scope from Phase 1. PostgreSQL is never "deferred."

2. **Sequential execution is a policy setting, not a schema limitation.** Enforced via workflow
   locks/leases with fencing tokens (monotonically increasing; persistence layer rejects
   stale-fence writes), not a hard schema invariant.

3. **GitHub webhooks are the primary event source.** Scheduled reconciliation is the fallback/
   repair mechanism, not the primary path.

4. **Workflow Layer** is the subsystem name for durable workflow execution. The implementation is
   Trigger.dev, but the docs use "Workflow Layer" for the architectural role everywhere except when
   explicitly referring to the Trigger.dev product (CLI namespace `minicoder trigger ...`, deployment
   tiers/backends, concrete runtime diagnostics like "underlying Trigger.dev run").

5. **Trigger.dev execution backend is a separate axis from the state store.** Default = self-host
   single-node (Docker Compose: webapp + Postgres + Redis + worker). Self-host HA cluster and
   Trigger.dev Cloud are drop-in options. Switching backends is a deployment/config decision only —
   except Cloud is also a security/compliance decision (payloads leave the user's boundary).

6. **Security is a design property established in Phases 1–3.** Never defer secrets management,
   audit actor identity, webhook-secret verification, or workspace sandboxing to later phases.

7. **Orchestrator Core is provider-SDK-free.** No provider SDK import in core. Domain logic stays
   in core, not in Workflow Layer task wrappers (architectural fitness tests enforce this in Phase 2).

8. **Markdown artifacts are never runtime state.** `plan.md`, `backlog.md`,
   `final-design-document.md` are generated/importable snapshots only.

9. **Private chain-of-thought is never stored or exposed.**

10. **SQLite is never used over a network filesystem.** Hosted/team always uses PostgreSQL.

## Vocabulary — Always Use These Exact Tokens

State names, role names, and identifier formats are canonical in `docs/00-glossary-and-terms.md`.
Use them verbatim:

### Feature execution states (§3.2)

```
approved_pending_execution → selected → coding → code_pushed → pr_opened → ci_running
→ under_review → changes_requested → fixing → code_pushed → ci_running → under_review
→ approved_by_policy → merge_ready → merged
```

Also: `ci_failed`, `merge_failed`, `human_required`, `blocked`, `failed`, `system_failed`

### Automation control states (§3.8)

```
running | paused_by_operator | paused_budget_exceeded | waiting_for_budget_approval
```

`resumed` is an **event**, not a state.

### Planning states (§3.1)

```
draft → pending_approval → approved → activated_for_execution
```

### Project lifecycle (§3.1)

```
active → implementation_complete → design_document_generating
→ design_document_ready_for_review → design_document_approved → project_complete
```

Revision loop: `design_document_ready_for_review → design_document_revision_requested
→ design_document_generating → design_document_ready_for_review`

### Agent adapter role names (§4.1)

```
PlannerAgentAdapter | CoderAgentAdapter | ReviewerAgentAdapter
ArbiterAgentAdapter | DocumentationAgentAdapter | HumanAgentAdapter
```

### Test mock names (§4.2)

```
MockPlannerAdapter | MockCoderAdapter | MockReviewerAdapter
MockArbiterAdapter | MockDocumentationAdapter | HumanTestAdapter
```

`HumanTestAdapter` is the deterministic test mock of `HumanAgentAdapter` — not the same thing.

### User/auth roles (§4.4)

```
viewer | operator | approver | admin
```

`approver`/`admin` is required for: plan activation, budget override, disagreement resolution,
merge-if-ready, final design-document approval, and guarded/destructive lifecycle actions.

### Identifiers (§3.11)

- Feature-request IDs: `FR-<zero-padded-int>` (e.g., `FR-002`)
- Feature branches: `minicoder/FR-<n>` (e.g., `minicoder/FR-002`)
- GitHub review-gate status check: `minicoder/review-gate`

### Workflow Layer task IDs (exact strings, no drift)

All 16 canonical task IDs (`ALL_TASK_IDS` in `packages/triggerdev/src/task-ids.ts`). The 9 Phase 3
tasks and the 6 Phase 6 additions are listed together — there is no "initial vs. later" distinction
in the token set itself, only in when each task's `runImpl` was wired to a real core command:

```
ingest-specification | planning-readiness-assessment | start-clarification
record-clarification-answer | complete-clarification | generate-implementation-plan
generate-feature-backlog | validate-backlog | request-plan-approval
activate-approved-backlog | start-next-feature | run-coder | github-reconciliation
export-plan | export-backlog | import-backlog
```

Every canonical task, including `github-reconciliation` (Phase 7), `start-next-feature`
(Phase 8), and `run-coder` (Phase 9), now calls a real Orchestrator Core command through
`TransactionalCommandExecutor`.

### Review finding severities (§3.7)

```
blocking | non_blocking | question | nit | out_of_scope | requires_human_decision
```

`requires_human_decision` prevents merge and routes via `human_required`.

## CI Loop Rule

**Every new push re-enters CI.** A fix always flows:

```
fixing → code_pushed → ci_running
```

before returning to `under_review`. Review and merge never act on un-tested code.

## Outbox / Inbox Rules

- Draining is **deterministic backoff polling**, NOT WAL-tailing (portability across SQLite/PostgreSQL).
- Each `outbox_events`/`inbox_events` row stores `payload` + `payload_schema_version` (the Zod schema version string).
- Task payloads carry **references and IDs, never secrets** and never raw secret-bearing material.
- `InboxProcessor` validates `payload_schema_version === SCHEMA_VERSION` and runs `validateEventPayload()` before calling any handler; mismatches are marked `failed` without invoking the handler.
- Batch SELECT uses a two-pass strategy: known event types fill the batch first (`IN (...)`), then unknown types fill the remainder (`NOT IN (...)`). Unknown events are never allowed to starve registered handlers.
- Events with no registered handler are requeued with `next_retry_at = now + maxBackoffMs` (attempts not incremented) so they become eligible once a handler is registered.

## Workflow Package Operational Constraints (`packages/workflow/`)

- **`staleClaimMs` must be a finite integer ≥ 2.** Both `OutboxDispatcher` and `InboxProcessor` throw in the constructor for values below 2, `NaN`, `Infinity`, or non-integers. Values below 2 produce a zero-delay heartbeat spin loop AND make the stale-claim threshold fire immediately (reclaiming active claims on the very next poll).
- **Heartbeat ownership loss.** The heartbeat UPDATE uses `executeAffected`; if 0 rows are returned (stale-claim recovery reclaimed the row) or the UPDATE throws (transient DB failure), `lostOwnership` is set and the handler result is **not** counted — `markDelivered`/`markProcessed`/`markFailed` is skipped. The handler still runs to completion.
- **Lock fencing — release is an UPDATE, not a DELETE.** `WorkflowLockManager.release()` updates `expires_at = now` and increments `fence`, preserving the row. The monotonically increasing fence counter must survive across acquire/release cycles so re-acquisition always returns a strictly higher fence. Deleting the row would reset the fence to 1.
- **`assertFence` must run inside the same transaction as the guarded write** to prevent TOCTOU races between the fence check and the protected state mutation.

## Trigger.dev Operational Constraints (`packages/triggerdev/`)

- **9-service compose stack.** `infra/docker-compose.triggerdev.yml`: `triggerdev-init`
  (one-shot alpine:3.19 chown, must exit 0 before webapp/supervisor start), postgres, redis,
  electric, webapp, registry, minio, docker-proxy, supervisor.
- **Supervisor network.** Supervisor must join the `triggerdev-webapp` Docker network.
  Set `TRIGGER_WORKLOAD_API_DOMAIN=triggerdev-supervisor` so runner containers can reach the
  workload API by hostname. Supervisor healthcheck uses a Node `http.get` call (no curl in
  the Node image).
- **OTEL endpoint.** `OTEL_EXPORTER_OTLP_ENDPOINT=http://triggerdev-webapp:3000/otel` —
  NOT the standard OpenTelemetry port `:4318`.
- **Registry topology.** `DEPLOY_REGISTRY_HOST` (CLI push target) and `DOCKER_REGISTRY_URL`
  (supervisor pull source) must point to the same registry. For GitHub-hosted CI runners,
  `localhost:5000` is unreachable; both vars need an external registry.
- **`assertSchemaReady()`.** `packages/triggerdev/src/db.ts` probes `triggerdev_runs`
  immediately after connecting. Missing table → actionable error. Run `minicoder db migrate`
  before starting tasks.
- **CLI pin.** Deploy with `npx trigger.dev@4.4.6 deploy …`. Never use `@latest`.
- **All secrets use `${VAR:?message}` syntax** in `docker-compose.triggerdev.yml` — Docker
  Compose exits on missing/empty values.

## Agent Adapter Operational Constraints (`packages/core/src/adapters/`, `packages/testing/src/conformance/`)

- **`AdapterRegistry.register` uses `INSERT ... ON CONFLICT (role, name) DO NOTHING`, never a
  catch-and-requery pattern.** In PostgreSQL, a failed `INSERT` (unique-constraint violation)
  aborts the enclosing transaction, so any later query in that same transaction fails with
  "current transaction is aborted". `DO NOTHING` never errors, so re-selecting the winning row
  and falling through to `UPDATE` stays inside a healthy transaction. Idempotent re-registration
  replaces capabilities and increments `version`.
- **Capability tokens are always runtime-validated via `parseCapabilities()`, never cast
  directly.** Both `AdapterRegistry.register()` (caller-supplied input) and `toRecord()` (rows
  read back from `agent_capabilities`) call it; an unrecognized token throws
  `InvalidCapabilityError` rather than silently defeating `assertCapabilities`. It also dedupes
  and **sorts the result by canonical `AgentCapabilitySchema` order** — not by insertion order,
  `created_at`, or physical row order — because multiple capability rows written in the same
  registration call share an identical `created_at` timestamp, so timestamp-based ordering alone
  would not be reliably deterministic across storage engines.
- **`agent_configurations` has two partial unique indexes (migration 0006), not a single
  `UNIQUE(adapter_id, project_id)`.** A plain composite unique constraint would not catch
  duplicate default rows, since SQL treats every `NULL` as distinct: `uq_agent_configurations_default`
  on `(adapter_id) WHERE project_id IS NULL` (at most one default config per adapter) and
  `uq_agent_configurations_project` on `(adapter_id, project_id) WHERE project_id IS NOT NULL`
  (at most one config per adapter/project pair). `AdapterRegistry.getConfiguration()` still adds
  a `version DESC, updated_at DESC` tiebreaker as defense-in-depth.
- **SQLite migration preflight remediation comments use `ROW_NUMBER() OVER (PARTITION BY ...
ORDER BY updated_at DESC, id DESC)`, never `MAX(rowid)`.** `rowid` reflects insertion order,
  not `updated_at`, and does not match the stated "keep the most-recently-updated row" policy.
  This applies to the dedup guidance in migrations `0003_unique_adapter_role_name.sqlite.sql` and
  `0006_unique_agent_configurations.sqlite.sql`.
- **`AgentRunRecorder.record()` resolves adapter provenance from the registry automatically —
  callers never supply `adapterName`/`adapterImplementation`/`adapterVersion`.** It also validates
  the caller-supplied `role` against the registry record (`RunRoleMismatchError` on mismatch) and
  validates `capabilitiesUsed` is a subset of the adapter's declared capabilities
  (`UndeclaredCapabilityError` otherwise). `capabilitiesUsed` is a **required** field on
  `RecordRunOptions` (never defaulted to `[]`) so a capability-bearing run cannot silently
  persist an empty provenance record — pass `[]` explicitly only for calls that genuinely
  exercise no declared capability.
- **`adapter_conformance_results` is append-only.** There is no unique key on
  `(test_suite, adapter_id)` and `runConformanceSuite()` never upserts — every call inserts a
  fresh row per adapter, even when re-run against the same DB with the same (idempotently
  re-registered) adapters. It is a historical audit log, not a current-gate-state row; query
  `ORDER BY run_at DESC, id DESC LIMIT 1` scoped to `(test_suite, adapter_id)` for "the current
  result" — the `id DESC` tiebreaker is required (issue #27), not optional: `run_at` is an
  ISO-8601 string with only millisecond resolution, so two rows written within the same
  millisecond leave `ORDER BY run_at DESC` alone to unspecified result ordering.
  The conformance runner's `configuration_resolution` scenario upserts (SELECT-then-UPDATE-or-
  INSERT) its own default config row rather than using an unconditional `INSERT`, so
  `runConformanceSuite()` is safe to re-run against a persistent DB.
- **Phase 5 delivers smoke-level conformance only.** The 9-scenario suite verifies adapter
  wiring (capability declaration, successful run, failure handling, invalid-output handling,
  secret redaction, configuration resolution, state-transition sequence, output shape,
  assertCapabilities) via direct invocation by the conformance runner and `AgentRunRecorder` —
  not via Workflow Layer task wrappers. Timeout taxonomy, cost/token reporting, structured-output
  normalization, and Workflow Layer wrapper invocation are deferred to the full canonical
  adapter-contract gate in Phase 9+.

## Bootstrap Planner and Clarification Operational Constraints (`packages/core/src/commands/handlers/{planning,clarification}/`, migrations 0007–0008)

- **`clarification_sessions`/`clarification_questions`/`clarification_answers`/`clarification_decisions`
  (migration 0007) persist the `ClarificationStatus` machine.** Gaps and assumptions raised or
  resolved during clarification reuse `planning_gaps`/`planning_assumptions` via a nullable
  `clarification_session_id` — there are no separate `clarification_gaps`/`clarification_assumptions`
  tables (docs/02 §4).
- **A `clarification_sessions` row's genesis is an `INSERT`, not a matrix transition** — like
  `implementation_plans` starting at `draft`. `AssessPlanningReadinessHandler` inserts it directly at
  `clarification_required` (insufficient) or at `clarification_not_required` then immediately
  transitions it to `clarification_complete` (sufficient/sufficient_with_assumptions), all inside
  one transaction, and stamps `assessment_id` (migration 0008) for exact provenance.
- **`GenerateImplementationPlanHandler`'s clarification guard is scoped to the assessment in use,
  not "the project's most recent clarification session."** Multiple assessments in one project each
  have their own session; querying by `assessment_id` (not `project_id`) avoids an unrelated
  newer/older session wrongly blocking or wrongly allowing plan generation.
- **`feature_requests.state` is a static label — never updated by transitions.** It is set once at
  backlog generation (`GenerateFeatureBacklogHandler`/`ImportBacklogHandler`) and never touched
  again. The real execution-readiness gate is `feature_runs`: `ActivatePlanHandler` inserts one row
  per `kind='feature'` request (`attempt_no=1`, `current_execution_state=approved_pending_execution`)
  when a plan activates; `kind='discovery'` rows never get one (docs/02 §5).
- **Plan submission requires a current, passing backlog validation (migration 0008).**
  `implementation_plans.backlog_version` increments every time
  `GenerateFeatureBacklogHandler`/`ImportBacklogHandler` (re)writes features for a plan, which also
  resets `backlog_validated_at`/`backlog_validated_state`/`backlog_validated_version` to `NULL`.
  `ValidateBacklogHandler` records its outcome against the plan's current `backlog_version`.
  `SubmitPlanForApprovalHandler` requires `backlog_validated_state = 'valid' AND
backlog_validated_version = backlog_version` — checking unresolved blocking `planning_gaps` alone
  is not sufficient; a stale validation from before the latest backlog change must not count.
- **`RequestAnotherClarificationRoundHandler` requires every question in the current round to be
  answered before reopening** — the same unanswered-question guard
  `CompleteClarificationHandler` uses. `BlockClarificationHandler` is intentionally exempt: it is
  the circuit-breaker/timeout escape path (docs/02 §4) and must stay usable precisely when answers
  did not arrive in time.
- **`packages/triggerdev/src/tasks/validate-backlog.ts` must only catch the `CommandError` with
  `type: 'backlog-invalid'`.** A bare `catch` that reports every error as `{ valid: false }` hides
  real DB/infrastructure/programmer failures from Trigger.dev's retry/failed-status handling —
  every other error type must re-throw.
- **`planning-readiness-assessment` and `generate-implementation-plan` never import a concrete
  `PlannerAgentAdapter` implementation.** The caller injects one (test scenarios pass
  `MockPlannerAdapter`); no reference/generic planner adapter has shipped yet (docs/02 §7 names
  `GenericLLMPlannerAdapter` as future work), so a live Trigger.dev deployment fails fast with an
  actionable error until one exists.

## GitHub Integration Operational Constraints (`packages/github/`, `packages/core/src/github/`, migration 0009)

- **`GitHubClient` is an interface in `packages/core/src/github/client.ts`; the Octokit
  implementation lives only in `packages/github`.** Orchestrator Core never imports Octokit
  (enforced by the `no-provider-imports` fitness test's `@octokit`/`octokit` banned-import
  entries) — the same "interface in core, implementation elsewhere" pattern Phase 5 used for
  adapter roles.
- **`packages/github` pins `@octokit/rest@^19` and `@octokit/webhooks-methods@^3`, not the
  current majors.** Current Octokit majors (`@octokit/rest@22`, `@octokit/webhooks-methods@6`)
  ship `"type": "module"` with no CommonJS export condition; this repo's TypeScript output target
  is CommonJS (`module: "CommonJS"` in `tsconfig.base.json`). Upgrading either package requires
  either moving the whole build to ESM or using dynamic `import()` at the call site — do not bump
  past a CJS-compatible major without one of those changes.
- **`reconcileGithubState()` (`packages/core/src/github/reconcile.ts`) is the single
  reconciliation algorithm** — both `packages/github`'s webhook-triggered `InboxHandler`s and the
  scheduled `github-reconciliation` Trigger.dev task call it with an already-fetched
  `ObservedPullRequestState`. Core never calls `GitHubClient` itself; the caller (inbox handler or
  task) fetches observed state first. Do not duplicate the compare/dispatch logic in either
  caller.
- **`pull_requests.review_state`/`ci_status` are observed mirrors of GitHub, not
  state-machine-governed columns.** They are overwritten directly by `reconcileGithubState()`'s
  dispatched commands; there is no `StateTransitionValidator` matrix for them (GitHub remains
  authoritative — glossary §3.10).
- **`FEATURE_EXECUTION_MATRIX` carries an `EscalateToHumanCommand` transition to `human_required`
  from every non-terminal feature-execution state (14 states: `approved_pending_execution`,
  `selected`, `coding`, `code_pushed`, `pr_opened`, `ci_running`, `under_review`,
  `changes_requested`, `fixing`, `approved_by_policy`, `merge_ready`, `ci_failed`,
  `merge_failed`, `system_failed`) for GitHub-reconciliation irreconcilable divergence** (PR
  closed without merging while MiniCoder still expected it open) — `reconcileGithubState()`'s
  `irreconcilablyClosed` check targets any state not in `{merged, human_required, blocked,
failed}`, so the matrix must cover every state that check can reach; a mid-flight PR close
  during a fix-cycle re-push (`code_pushed`) or review loop (`changes_requested`/`fixing`) is
  just as irreconcilable as one observed at `pr_opened`/`ci_running`. These transitions are
  dispatched exclusively by `reconcileGithubState()`'s escalation path, not by any other caller.
- **`RecordCiFailedHandler`/`RecordChangesRequestedHandler` do not increment a fix-attempt
  counter or write `review_findings`.** `feature_runs` has no fix-attempt-count column yet — that
  counter and the blocking-findings write path are Phase 10 (review/fix loop) scope. Do not add
  ad hoc fix-attempt tracking to these handlers before Phase 10 lands the real column.
  **Superseded by Phase 10:** `feature_runs.fix_attempt_count` (migration 0011) now exists and both
  handlers increment it and write `review_findings` — see the Reference Reviewer Adapter and
  Review/Fix Loop Operational Constraints section below.
- **`github-reconciliation`'s scheduled fallback only re-checks feature runs that already have a
  `pull_requests` row.** Discovering a brand-new PR that no webhook has ever reported requires a
  `GitHubClient.listPullRequestsForBranch`-style method that does not exist yet — do not assume
  the scheduled task will self-heal a completely missed `pr.opened` webhook.
- **`github-reconciliation` treats a per-candidate transient concurrency loss as a skip, not a
  batch abort.** A lock-gated candidate (`code_pushed`/`pr_opened`) whose
  `execution-lane:{projectId}` lock is held by another actor (the `start-next-feature` task, a
  webhook-triggered inbox handler, or an HA-cluster peer) makes `lockManager.acquire()` throw
  `LockConflictError`. That, plus `OptimisticLockError` (a concurrent version bump under a
  `Record*` command's CAS), `StaleFenceError` (a reclaimed lease), and a `concurrent-command`
  `CommandError` (an in-flight idempotency-key race with a webhook handler running the same
  transition), are classified by the same `isTransientRace()` helper `start-next-feature.ts` uses
  and cause the loop to `continue` to the next candidate — the held candidate is reconciled by a
  later scheduled pass. Leaving these uncaught (as the original per-candidate loop did) aborts
  reconciliation of the whole batch and fails the task on a routine concurrency condition (a real
  bug — HIGH-1 in a later Phase 8 code review round). The wrapping `try` covers only the
  `reconcileGithubState`/`reconcileWithLock` calls, **not** the `GitHubClient.getPullRequest`
  fetch — a genuine GitHub API or DB failure there is handled by its own, separate try/catch (see
  the next bullet), not this one.
- **`github-reconciliation`'s `GitHubClient.getPullRequest()` call also isolates per-candidate
  failures, with one deliberate exception (issue #42).** A transient GitHub API failure (rate
  limit, timeout, a single malformed/inaccessible PR) fetching one candidate is logged
  (`console.error`, so an operator can see it happened — also reflected in the task's
  `GithubReconciliationResult.fetchFailures` count) and the loop `continue`s to the next candidate,
  rather than aborting the whole batch — the same "one bad candidate shouldn't kill the batch"
  shape the concurrency-race fix above already established, extended to the GitHub API path. The
  deliberate exception: a 401/403 (credential-class failure) still throws and aborts the whole
  task, since it would affect every remaining candidate identically and retrying
  candidate-by-candidate wastes rate-limit budget with no chance of succeeding until the credential
  itself is fixed. Any other thrown status (or a DB failure) also still throws, correctly failing
  the task for Trigger.dev retry — only the two named cases (transient fetch failure → skip;
  401/403 → abort) are special-cased.
- **`minicoder github serve` is intentionally not gated by `guardEnv()`** (unlike
  `github simulate-*`), since it is the real webhook receiver and must run in production/hosted
  deployments. Do not add the dev/test/ci environment guard to it.

## Execution Orchestrator Operational Constraints (`packages/core/src/commands/handlers/{automation,feature}/`, `packages/core/src/cost/`)

- **Sequential execution is enforced by two mechanisms with two different jobs — do not collapse
  them into one.** `SelectFeatureHandler`'s atomic conditional `UPDATE workflow_states SET
active_feature_run_id = ? WHERE automation_state = 'running' AND active_feature_run_id IS NULL`
  is the durable, crash-surviving **single-active-feature-per-project** invariant — a
  compare-and-swap on one column that is correct without a lease/TTL, since "active" must persist
  until the feature completes, not until a lock expires. `packages/workflow`'s `ExecutionLane`
  (a fence-token lock) is the short-lived, heartbeat-able mutual-exclusion guard for handlers that
  mutate an _already-selected_ `feature_runs` row (`StartCodingHandler`, `RecordCodePushedHandler`,
  `StartFixingHandler`) — it protects against two concurrent writers racing on the same feature
  run (e.g. overlapping `start-next-feature` task retries), which the `workflow_states`
  compare-and-swap does not cover once a feature is already selected. `SelectFeatureHandler`
  correctly takes no lock (there is nothing to hold — it is a single atomic UPDATE); the handlers
  that mutate an active feature run's state correctly require `envelope.lockContext`.
- **`StartFixingHandler` and `UnblockFeatureHandler` are intentionally orphaned.** Both are real,
  matrix-defined transitions (`changes_requested → fixing`, `blocked → approved_pending_execution`)
  built and exported in Phase 8, but neither has a caller yet: the review/fix loop that decides
  when a feature re-enters `fixing` is Phase 10 scope, and nothing in Phase 8 ever transitions a
  feature run to `blocked` in the first place. This is the same posture Phase 7 left
  `StartCodingHandler`/`RecordCodePushedHandler` in before Phase 8 gave them a caller — do not
  treat an orphaned-but-tested handler as dead code to delete.
  **Superseded by Phase 10 for `StartFixingHandler`:** `run-review.ts` now calls it after a
  blocking-finding-driven `RecordChangesRequestedCommand` succeeds. `UnblockFeatureHandler` remains
  orphaned — nothing transitions a feature run to `blocked` yet.
- **`ApproveBudgetOverrideHandler` serves two matrix edges from one handler** —
  `paused_budget_exceeded → running` and `waiting_for_budget_approval → running` both dispatch
  `ApproveBudgetOverrideCommand`; `StateTransitionValidator` resolves the correct matrix row from
  `(fromState, commandName)`, so no branching is needed in the handler. Callers must select the
  idempotency-key template matching the origin state they observed
  (`budget-override:{projectId}:{expectedVersion}` vs
  `budget-override-waiting:{projectId}:{expectedVersion}`) — this is the one command in the
  codebase without a single fixed idempotency-key template. The handler also emits **two**
  `workflow_events` per the matrix's two declared `emittedEvents`
  (`automation.budget_override_approved` and `automation.resumed`) — the first multi-event handler
  in the codebase.
- **Every repeatable automation-control/feature-execution transition's idempotency key must
  include `{expectedVersion}` (or another per-occurrence discriminator), never
  `{projectId}`/`{featureRunId}` alone.** A project can legitimately breach the same budget
  threshold, get overridden, and breach again; be paused, resumed, and paused again; and a
  feature run can cycle `changes_requested → fixing` more than once — each occurrence is read
  against a distinct version. A key scoped to the entity id alone lets
  `TransactionalCommandExecutor` return the _first_ occurrence's cached `CommandResult` for every
  later one within the 7-day idempotency TTL, silently no-opping the transition. This was a real
  bug (HIGH-1 in a Phase 8 code review round) fixed for `RecordBudgetExceededCommand`/
  `RecordBudgetApprovalWaitingCommand` in `apply-budget-decision.ts`, and (MEDIUM-1 in a later
  round) for `PauseAutomationCommand`/`ResumeAutomationCommand`/`StartFixingCommand`'s matrix
  templates and handler doc comments — `ApproveBudgetOverrideCommand` already documented the same
  caller obligation. At the time of that round, none of `PauseAutomationCommand`/
  `ResumeAutomationCommand`/`StartFixingCommand`/`ApproveBudgetOverrideCommand` had a real
  production caller yet (Phase 13's API / Phase 10's review-fix loop would supply one), so the fix
  was the documented contract plus `packages/testing/src/automation-control-race.test.ts`'s
  regression coverage, not a handler code change — the handlers' own version-based CAS was already
  correct; only the caller-supplied key was under-scoped. **Phase 10 update:** `StartFixingCommand`
  now has a real caller (`run-review.ts`, idempotency key `start-fixing:{featureRunId}:
{expectedVersion}`, refetching `expectedVersion` after `RecordChangesRequestedCommand` succeeds) —
  `PauseAutomationCommand`/`ResumeAutomationCommand`/`ApproveBudgetOverrideCommand` still await
  Phase 13's API layer. The `execution-orchestrator` scenario's step 4b exercises a repeated soft
  breach for the one command (`RecordBudgetApprovalWaitingCommand`) that does have a real caller
  (`applyBudgetDecision()`).
- **`StartCodingHandler` and `StartFixingHandler` atomically re-check
  `workflow_states.automation_state = 'running'` as part of their `feature_runs` UPDATE, not just
  via an earlier plain-`SELECT` pre-check.** A pause or budget breach that commits in the window
  between `SelectFeatureCommand` succeeding and `StartCodingCommand` dispatching (or between a
  review cycle's guard check and `StartFixingCommand` dispatching) must not let new automated work
  start anyway — this was a real bug (HIGH-1 in a Phase 8 code review round): `start-next-feature.ts`
  checked `automation_state` once at the top, then dispatched two separate commands with lock
  acquisition and other queries in between, and neither `StartCodingHandler` nor
  `StartFixingHandler` re-checked `automation_state` before advancing the feature run. Fixed by
  adding `AND EXISTS (SELECT 1 FROM workflow_states WHERE project_id = ? AND automation_state =
'running')` to each handler's conditional `UPDATE`, with the same two-step disambiguation
  `SelectFeatureHandler` already uses (a 0-row UPDATE re-queries `workflow_states` to distinguish
  a stale version from a no-longer-running automation state, throwing the `automation-paused`
  `CommandError` type `start-next-feature.ts`'s `isTransientRace()` already treats as non-fatal).
  `RecordCodePushedHandler` deliberately does **not** get this guard — it records the outcome of
  work already in flight rather than starting new work, so a pause after coding has already begun
  should not prevent recording that the push happened.
- **`start-next-feature.ts` must check `workflow_states.active_feature_run_id` for a stranded
  `selected` run before falling back to `findNextEligibleFeatureRun()` — for both the
  auto-discovery and the explicit-`featureRunId` call paths.** The HIGH-1 fix above (rejecting
  `StartCodingCommand` when automation isn't `running`) can leave a feature run parked at
  `selected` with `active_feature_run_id` still pointing at it — and
  `findNextEligibleFeatureRun()` only ever searches for `approved_pending_execution` rows, so
  that stranded run would never be found again via auto-discovery, permanently blocking the
  project even after automation resumes (`SelectFeatureHandler`'s compare-and-swap also refuses
  to select anything else while `active_feature_run_id` is non-`NULL`). The same check must also
  apply when a caller passes `featureRunId` explicitly (e.g. a targeted retry) and it happens to
  equal the stranded active run — skipping it left a real bug where `SelectFeatureCommand` was
  dispatched on an already-`selected` run, an invalid `selected -> selected` transition that
  throws an uncaught `TransitionError` (a plain `Error`, not a `CommandError`, so
  `isTransientRace()` cannot catch it) instead of recovering (a later Phase 8 code review round).
  When the resolved `featureRunId` — whichever path supplied it — is at `selected`, the task must
  skip `SelectFeatureCommand` and dispatch `StartCodingCommand` directly for that run,
  regression-tested in `packages/triggerdev/src/triggerdev.test.ts` for all three
  paused/budget-paused automation states (auto-discovery) and for the explicit-`featureRunId`
  case.
- **`start-next-feature.ts` treats every transient concurrency loss as `started: false`, never a
  thrown task failure — and `ExecutionLane.acquireForProject()` must be caught, not left to
  propagate.** The task is scheduled/opportunistic and idempotent, so any "another actor moved
  state under us" condition should defer to the next tick. Its `isTransientRace()` helper covers
  `LockConflictError` (a concurrent holder of the same `execution-lane:{projectId}` lock — most
  commonly a `github-reconciliation` pass, which acquires that exact lock, or an HA-cluster
  peer), `OptimisticLockError` (a concurrent writer bumped `feature_runs.version` between this
  task's fresh read and a command's CAS), `StaleFenceError` (the lane lease was reclaimed
  mid-op), and the expected `CommandError` types (`feature-already-active`, `automation-paused`,
  `unmet-dependencies`, `not-found`, `concurrent-command`). The lane acquire is wrapped in its
  own `try` so a `LockConflictError` returns `started: false` **without** entering the
  release-in-`finally` block — leaving `acquireForProject` uncaught (or outside the `try`) turns
  a routine concurrency condition into a spurious Trigger.dev failure (a real bug — HIGH-1 in a
  later Phase 8 code review round; the lane acquire had been outside the `try` entirely). A
  genuine infrastructure failure is none of those types and still throws, correctly triggering
  retry. The `select-feature:{featureRunId}` / `start-coding:{featureRunId}` idempotency keys are
  intentionally **not** `{expectedVersion}`-scoped (unlike the recurring project-scoped
  automation-control keys): a `feature_runs` row is a single attempt that transitions
  `→selected`/`→coding` at most once, so the run id is already occurrence-unique, and a failed
  attempt rolls back its claim inside the handler transaction so retries re-execute.
- **`evaluateBudget()` is retrospective-threshold-only, by design.** It sums `cost_records.amount`
  live (respecting `window_days` when set) and compares against `budget_policies.soft_limit`/
  `hard_limit` — hard checked before soft, so a policy breaching both reports `hard_breach`. There
  is deliberately no denormalized running-total column: Phase 8 data volumes don't warrant a second
  source of truth to keep consistent with `cost_records`. Forecasting, per-`AgentRun` pre-flight
  caps, and dashboards (docs/01 §5.11) are Phase 16 scope — do not add them to `evaluateBudget()`.
  When more than one active `budget_policies` row matches the same `(project, scope, feature)`
  tuple — nothing currently prevents this — the query orders by `updated_at DESC, id DESC` and
  picks the first match, the same "most recent wins" tiebreaker `AdapterRegistry.getConfiguration()`
  already uses for an analogous ambiguity, rather than relying on unspecified SQL result ordering.
- **`RecordBudgetExceededHandler`/`RecordBudgetApprovalWaitingHandler` write no `cost_records` row
  themselves** — a breach can only be evaluated against rows that already exist; `evaluateBudget()`
  must run _after_ the code path that inserted the triggering `cost_records` row, not before it.
  Neither handler writes a `policy_decisions` row either (only `ApproveBudgetOverrideHandler`/
  `ResumeAutomationHandler` do, matching the matrix's `record_policy_decision` side effect, which
  the two breach-recording edges do not carry) — this is intentional (see docs/01 §5.11): the
  automatic breach is fully reconstructable from `workflow_events`, while `policy_decisions` is
  reserved for the audit trail of judgment calls a human actually made.
- **`start-next-feature.ts`'s actor identity is a known Phase 13 placeholder.**
  `SelectFeatureCommand` requires a human/operator actor per its matrix row; the task has no real
  authenticated session to attribute the run to, so it uses a fixed `automationOperatorActor()`
  identity (`packages/triggerdev/src/tasks/actor.ts`) — the same category of placeholder
  `ActorPayload`'s doc comment already describes for human-initiated tasks. `StartCodingCommand`,
  by contrast, requires a system actor per its own matrix row and continues to use the existing
  `systemActor()`. Do not weaken either handler's `requiredActorKind`/`requiredRole` just to
  simplify this task's caller — that would change accepted-command semantics repo-wide.
- **`findNextEligibleFeatureRun()` is a candidate-picker, not a second guard authority.** It is a
  plain read function, not a `CommandHandler` — no idempotency key, no lock, no state mutation.
  `SelectFeatureHandler` re-checks the dependency guard itself and remains the sole transition
  authority; a stale candidate (e.g. a dependency that changes between the read and the
  `SelectFeatureCommand` dispatch) is simply rejected by that handler, not by the picker.

## Reference Coder Adapter Operational Constraints (`packages/adapters-coder/`, migration 0010, `infra/docker-compose.coder-sandbox.yml`)

- **Code push uses local git, not a Git Data API.** `CodexCoderAdapter` (`packages/adapters-coder`)
  owns its own git clone/commit/push via `workspace.ts` (token-authenticated HTTPS remote,
  `child_process.execFile`/`docker exec` — never a shell string, never `--force`). `GitHubClient`'s
  interface (`packages/core/src/github/client.ts`) gained **no new methods** for this — adding
  `createBlob`/`createTree`/`createCommit` was considered and rejected: the adapter isn't part of
  `packages/core` (provider-SDK-free rule doesn't even apply to it), it already needs a real local
  checkout to run tests (`can_run_tests`), and Git Data API commits don't naturally support running
  a test suite before committing. The only new production behavior on `GitHubClient` is a new
  caller of the already-existing (previously uncalled) `createPullRequest`, from
  `packages/triggerdev/src/tasks/run-coder.ts`.
- **`workspace.ts` is runner-agnostic — never touches host `fs` directly.** Git commands _and_ file
  writes both go through an injected `CommandRunner` (`run(cmd, args, opts)`), so the identical
  orchestration code runs against `ChildProcessCommandRunner` (local, used by tests against a real
  throwaway git repo) or `CoderSandbox` (`docker exec` inside the ephemeral container) with zero
  branching. File writes use a `sh -c 'printf %s "$2" | base64 -d > "$1"'` one-liner (content
  base64-encoded into argv) rather than stdin plumbing or host `fs.writeFile`, precisely so the
  same call works whether the runner is local or inside a container.
- **`RecordCodePushedCommand`'s idempotency key was deliberately left unchanged
  (`record-code-pushed:{featureRunId}:{commitSha}`), not given an `{expectedVersion}` suffix.**
  Unlike the recurring project-scoped automation-control keys this document flags elsewhere,
  `commitSha` is already a per-occurrence discriminator — a genuinely new commit is produced (or,
  on idempotent retry, the same prior commit is deterministically reused, see below) per push, so
  the run id is not the only uniqueness anchor here. Do not "fix" this key; it was reviewed and is
  correct as-is.
- **Idempotent retry is a commit-trailer check, not a database record.** `workspace.ts` tags every
  commit with a `MiniCoder-Feature-Run: <featureRunId>` trailer
  (`FEATURE_RUN_TRAILER`) and, before writing anything, checks whether the branch's HEAD commit
  already carries that trailer for this run — if so, it returns the existing `commitSha` without
  re-committing or re-pushing (docs/03 §11.6: "must not double-commit/double-push" on retry).
- **`AgentRunRecorder` gained three additive, backward-compatible `RecordRunOptions` fields —
  `contextPack`, `costExtractor`, `toolOperationsExtractor` — none of which change any existing
  Phase 5/6 caller.** `costExtractor`/`toolOperationsExtractor` both take the run's full
  `RunOutcome<O>` (`{ok: true, output} | {ok: false, error}`), not just the success output, because
  a failed provider call can still carry partial token/cost usage worth recording — see the
  `run-recorder.test.ts` "also invokes costExtractor on failure" case. `costExtractor`'s returned
  `costUsd` (if any) is written to `cost_records` **before** `insertCostRecord` returns, and the
  caller's own `evaluateBudget()` call always runs after `recorder.record()` resolves — this
  write-then-evaluate ordering is what makes the Budget Gate section's "a fresh breach evaluation
  sees this run's cost" claim true for coder runs, not just a documented aspiration.
  `insertCostRecord` throws if `costUsd` is reported without a `projectId` on `RecordRunOptions` —
  `cost_records.project_id` is `NOT NULL` and there is no sensible fallback scope.
- **`cost_records.scope` is derived from whether `featureRequestId` was supplied, not a caller
  choice.** `featureRequestId` present → `scope='feature'` (matches `evaluateBudget()`'s
  feature-scoped query, which filters by `feature_request_id`); absent → `scope='project'`.
  `'agent_run'` is deliberately **not** a `cost_records.scope` value — `BudgetScope` only has three
  members (`project`/`feature`/`review_cycle`, `packages/core/src/domain/states.ts`), and a
  `cost_records` row using a scope no `budget_policies` row can ever match would be invisible to
  `evaluateBudget()`, silently defeating the write-then-evaluate contract above.
- **`run-coder.ts` is a separate, independently scheduled/triggered task from
  `start-next-feature.ts` — never inline the two.** This matches the already-established
  event-driven pattern (`pr_opened → ci_running` is reconciliation-driven, not chained in-process)
  and, just as importantly, avoids touching `start-next-feature.ts`'s logic, which has already
  been through six rounds of concurrency-bug code review (see the Execution Orchestrator section
  above) — every additional responsibility added to that file is another surface for a new race.
- **`run-coder.ts` resolves the `CoderAgentAdapter` _DB record_ via `AdapterRegistry` but takes the
  actual runtime _instance_ via a separate, caller-injected `CoderAdapterFactory`
  (`(repoUrl) => Promise<CoderAgentAdapter>`) — these are not the same lookup.** The registry only
  ever stores metadata (name/role/capabilities/version); there is no live-object registry the way
  there is for, say, Express middleware. A factory (not a constructed singleton, and not a
  factory with no arguments) is required because one deployment can serve multiple projects with
  different GitHub repos, and `CoderInput`/`CoderOutput` (the shared, Phase-5-vintage adapter
  contract) carry no repo/credential fields — those live on the factory-constructed instance, one
  per invocation, never on the wire-format input/output types. Do not add `repoUrl` to
  `CoderInput` to "simplify" this; it would also require every other role's `Input` type and every
  existing `MockCoderAdapter` call site to change for no benefit.
- **The default `CoderAdapterFactory`/`GithubClientFactory` construct real implementations from
  env vars via dynamic `import()`, exactly mirroring `github-reconciliation.ts`'s existing
  `resolveDefaultGithubClientFactory` pattern for `OctokitGitHubClient`.** `GITHUB_TOKEN` (shared
  with the GitHub-reconciliation task), `CODE_GEN_BASE_URL`/`CODE_GEN_API_KEY`/`CODE_GEN_MODEL`,
  and `CODER_SANDBOX_IMAGE`/`CODER_SANDBOX_NETWORK`/`CODER_SANDBOX_DOCKER_HOST`/
  `CODER_SANDBOX_HTTPS_PROXY` (the latter two optional, defaulting to the local Docker socket and
  no proxy) are read lazily inside the resolver closures, not at module load — a live deployment
  missing any required var fails fast with an actionable error only when the default path is
  actually exercised; test scenarios never hit this code path since they always inject
  `MockCoderAdapter`/`MockGitHubClient` explicitly via `RunCoderDeps`.
- **A PR-creation failure after a successful push is logged and swallowed, never re-thrown or
  rolled back.** `run-coder.ts` calls `GitHubClient.createPullRequest` **after** — and outside the
  lock of — the already-committed `RecordCodePushedCommand` dispatch; the coder's work is already
  durably recorded as `code_pushed` by that point, so a GitHub API hiccup creating the PR is a
  non-fatal, retryable side effect (a later `github-reconciliation` pass or a human can retry PR
  creation), not a reason to fail the whole task or claim the push never happened.
- **On adapter failure, the feature run is deliberately left at `coding` — no new `coding →
failed`/`coding → blocked` matrix edge was added.** `RecordCodePushedCommand` is never dispatched
  in this path, and no other command touches `feature_runs`. The escalation loop that decides what
  happens next (retry, fix-cycle, human escalation) is Phase 10/11 scope — the same "handler
  exists, caller lands later" posture Phase 8 left `StartFixingHandler`/`UnblockFeatureHandler` in.
- **`isTransientRace()` moved to a shared `packages/triggerdev/src/tasks/transient-race.ts`,
  taking the caller's expected-`CommandError`-type set as a parameter.** `start-next-feature.ts`'s
  previously-duplicated private copy (and `github-reconciliation.ts`'s near-identical one) both now
  call this shared function — `isTransientRace(err, expectedCommandErrorTypes)` — passing their
  own task-specific allow-list (`start-next-feature.ts`'s is broader: it also treats
  `feature-already-active`/`automation-paused`/`unmet-dependencies`/`not-found` as expected races
  that `github-reconciliation.ts`/`run-coder.ts` don't). The `LockConflictError`/
  `OptimisticLockError`/`StaleFenceError` classification itself is identical across all three
  callers and lives only in this one function now.
- **The sandbox is real container isolation, not yet daemon-verified in this repository's CI.**
  `packages/adapters-coder/src/sandbox.ts`'s `CoderSandbox` creates one ephemeral, non-root,
  capability-dropped (`CapDrop: ['ALL']`), read-only-root-filesystem container per run via
  `dockerode`, attached only to the `internal: true` `minicoder-coder-sandbox` network defined in
  `infra/docker-compose.coder-sandbox.yml`, with the `coder-sandbox-egress-proxy` (`tinyproxy`,
  `FilterDefaultDeny yes`) as its only egress path. Unit tests exercise this against a fake
  `dockerode` client (`DockerLike`), not a real daemon — the implementation session had no
  reachable Docker daemon (`docker info` failed), so the compose stack was written and
  syntax-validated (`docker compose config`) but never run end-to-end, and no Docker-daemon-gated
  integration test exists yet proving egress denial actually blocks a disallowed host. Treat this
  as real, reviewed infrastructure that needs a live-daemon verification pass, not as
  aspirational/un-built — see docs/07 §6's "Phase 9 implementation status" for the exact real-vs-
  aspirational split.
- **`agent_context_packs`, `agent_tool_operations`, and `cost_records` get their first production
  writers in Phase 9.** All three tables (plus `agent_runs.provider`/`.model`/
  `.prompt_template_version`, migration `0010_agent_run_provider_tracking.*`) existed since
  migration `0001` / Phase 5 with zero production INSERTs before this phase — only test-scenario
  fixtures wrote directly to `cost_records`. `agent_runs.triggerdev_run_id` was considered and
  rejected as a new column; `triggerdev_runs.linked_agent_run_id` already provides that join.

**Post-implementation review fixes (round 1):**

- **CRITICAL-1 (`feature.code_pushed` schema rejected real payloads).**
  `FeatureCodePushedPayloadSchema` required `.uuid()` for `featureRunId`/`projectId`, but
  `generateId()` (`packages/core/src/commands/helpers.ts`) returns `${Date.now()}-${random}`
  strings, never UUIDs — every real payload `RecordCodePushedHandler` emits would fail
  `InboxProcessor`'s `validateEventPayload()` check. This was a pre-existing, pre-Phase-7 latent
  bug (a prior Phase 7 review round found and fixed the identical class of bug on sibling schemas
  but explicitly left this one out of scope) — fixed here since Phase 9 directly extended this
  schema. Changed to `.min(1)`, matching the sibling schemas already using that pattern. Regression
  test in `packages/triggerdev/src/tasks/run-coder.test.ts` reads the actual emitted
  `outbox_events` row and validates it against `EVENT_SCHEMAS['feature.code_pushed']`.
- **HIGH-1 (`/workspace` was not writable in the sandbox).** `CoderSandbox` set
  `ReadonlyRootfs: true` with only `/tmp` mounted as a writable tmpfs, but `workspace.ts` clones
  into `/workspace` by default — every real sandbox run would fail at clone/write time despite
  passing against the fake-`dockerode` unit tests. Fixed by adding a writable tmpfs mount at
  `/workspace` (owned by the sandbox image's non-root uid/gid), matching the "nothing needs to
  persist past container removal" rationale already documented for `/tmp`.
- **HIGH-2 (git commits failed with no author identity).** The sandbox has no global git config,
  so `git commit` fails with "Author identity unknown." Fixed by setting a repo-local
  `user.name`/`user.email` in `prepareBranch()` unconditionally, rather than relying on an ambient
  global config that may not exist. Caught by running `workspace.test.ts` with an isolated `HOME`.
- **HIGH-3 (provider-controlled paths could escape the intended tree before the diff guard ever
  ran).** `commitAndPush()` wrote every generated file _before_ calling `assertDiffWithinBounds()`,
  and that function only checked raw path strings — `../outside`, `/tmp/x`, or
  `foo/../.git/config` would already be written to disk by the time (or even before) any check
  ran. Fixed with `diff-guard.ts`'s new `validateRelativePath()` — normalizes `.`/`..` segments,
  rejects absolute paths (POSIX and Windows-drive) and paths escaping the repo root, and re-checks
  the _normalized_ path against the disallowed-path patterns — called in `workspace.ts` before
  each `writeFile()`, not after.
- **HIGH-4 (the GitHub token could leak through command error messages).**
  `authenticatedRemote()` embeds the token in the clone/push remote URL's userinfo, and a failed
  git command's thrown error included the full `args.join(' ')` (and often stderr echoing the same
  URL) — a failed clone/push could leak the token into Trigger.dev logs. Fixed with
  `workspace.ts`'s new `redactUrlCredentials()`, applied to every error this module throws, not
  just the clone/push call sites (any git subcommand can run against a repo whose `origin` still
  carries the credential).
- **HIGH-5 (coder runs never wrote `cost_records`, so budget gates saw zero coder spend).**
  `run-coder.ts`'s `costExtractor` returned token counts but no `costUsd`, and
  `AgentRunRecorder.insertCostRecord()` only writes a row when `costUsd` is present. Fixed by
  adding `computeCostUsd()` — a configurable per-1K-token price (env-overridable,
  `CODE_GEN_PRICE_PER_1K_INPUT_TOKENS`/`CODE_GEN_PRICE_PER_1K_OUTPUT_TOKENS`, defaulting to
  gpt-4o-mini-class pricing) applied to the reported token counts. This is a deliberate
  simplification, not real per-model pricing (that's Phase 16 observability scope) — but it makes
  `cost_records`/budget-gate integration actually non-zero instead of silently absent.
- **HIGH-6 (PRs were always opened against a hardcoded `main`).** `run-coder.ts` queried only
  `owner`/`name` from `repositories` and passed a literal `'main'` as `baseBranch`, ignoring the
  already-existing `repositories.default_branch` column — repos using `master`/`develop`/etc.
  would get PRs opened against the wrong base. Fixed by selecting and using `default_branch`.
- **MEDIUM-1 (`prompt_template_version` was declared but never persisted).** Migration 0010 added
  the column and `RecordRunOptions` exposed `promptTemplateVersion`, but the `AgentRunRecorder`
  INSERT never included it, so the column stayed `NULL` for every run regardless of what callers
  passed. Fixed by adding it to the initial `agent_runs` INSERT.
- **MEDIUM-2 (the code-generation provider received almost no repository context).**
  `CodexCoderAdapter` passed only the repo URL and branch name as `repoContext`, despite
  `CodeGenerationRequest`'s own doc comment describing it as "a file tree / relevant excerpts."
  Fixed with `workspace.ts`'s new `listRepoFiles()` (a bounded `git ls-files`, capped at 200
  entries) folded into `repoContext` — a deliberately modest improvement (a file listing, not file
  content excerpts); richer context assembly remains future work.
- **MEDIUM-3 (the production task payload defaulted to a test adapter name).**
  `RunCoderPayload.coderAdapterName` defaulted to `'MockCoderAdapter'`, while the default runtime
  resolver constructs a real `CodexCoderAdapter` — a production trigger omitting this field would
  silently resolve the wrong `AdapterRegistry` entry. Fixed by removing the default, making the
  field required; every production/test call site already passed it explicitly.
- **LOW-1 (tracked files failed `format:check`).** Ran Prettier on the phase's touched files.

**Post-implementation review fixes (round 2):**

- **HIGH-1 (the event-ID schema fix was incomplete — the same `.uuid()` mismatch was live on
  every other schema in the file).** Round 1 fixed only `FeatureCodePushedPayloadSchema` (the
  schema Phase 9 directly touched); `FeatureSelectedPayloadSchema`, `FeatureCodingStartedPayloadSchema`,
  `FeatureMergedPayloadSchema`, `PlanApprovedPayloadSchema`, `PlanActivatedPayloadSchema`,
  `AutomationPausedPayloadSchema`, and `AutomationResumedPayloadSchema` all still required
  `.uuid()` while every real ID in the system is a `generateId()` string — an active
  `InboxProcessor.validateEventPayload()` boundary that would mark these events `failed` without
  invoking the handler. Fixed everywhere in `packages/core/src/events/schemas.ts` in one pass
  (changed to `.min(1)`) rather than leaving a split contract across event families. New
  `packages/core/src/events/schemas.test.ts` asserts every previously-`.uuid()` schema accepts a
  realistic `generateId()`-shaped ID; the Phase 7 GitHub-facing events already had handler-driven
  coverage in `packages/testing/src/github-outbox-schemas.test.ts`, and `feature.code_pushed`'s is
  in `packages/triggerdev/src/tasks/run-coder.test.ts`.
- **MEDIUM-1 (`prompt_template_version` still wasn't populated for real coder runs).** Round 1
  taught `AgentRunRecorder` to persist `promptTemplateVersion` when supplied, but `run-coder.ts`'s
  `recorder.record(...)` call never passed one — the fix only proved out against synthetic/test
  calls. Fixed by adding a `CODER_PROMPT_TEMPLATE_VERSION` constant (env-overridable via
  `CODER_PROMPT_TEMPLATE_VERSION`) passed through at the real call site; asserted non-null in
  `run-coder.test.ts`'s happy-path test.
- **MEDIUM-2 (the egress-proxy/host-process trust boundary for code generation was undocumented
  and looked like an oversight).** `CodexCoderAdapter.run()` calls `CodeGenerationProvider.generate()`
  (a plain `fetch`) in the Trigger.dev task process, not inside `sandbox` — `CODER_SANDBOX_HTTPS_PROXY`
  only reaches the sandboxed container's `Env`, so it never governs this call, and the compose
  file's `CODE_GEN_ALLOWED_HOST` egress-proxy allow-list entry is consequently unused today. This
  is a deliberate design choice, not a gap: the sandbox container is the untrusted-code-execution
  boundary (it runs `pnpm install`/`pnpm test` against LLM-generated files), so `CODE_GEN_API_KEY`
  must never be reachable from inside it. Documented explicitly in docs/07 §6's "Phase 9
  implementation status", the compose file's `CODE_GEN_ALLOWED_HOST` comment, and a code comment
  at the `codeGenerationProvider.generate()` call site in `codex-coder-adapter.ts` — no code
  redesign, since moving the call into the sandbox would be the less secure option.
- **MEDIUM-3 (cost-pricing env vars were parsed without validation).** `computeCostUsd()` used
  `Number(process.env[...])` directly — a malformed, non-finite, or negative value would produce
  `NaN`/`Infinity`/a negative cost silently persisted into `cost_records`, poisoning budget-gate
  arithmetic. Fixed with `parsePriceEnvVar()`, which rejects non-finite/negative values (logging an
  error and falling back to the default) rather than propagating them. Tested in
  `run-coder.test.ts` for `'not-a-number'`/`'NaN'`/`'Infinity'`/`'-1'` (all fall back to the
  default, cost stays finite and positive) and for a valid custom price (honored exactly).
- **LOW-1 (the state-repair runbook's direct `runRunCoder` example omitted the now-required
  `coderAdapterName`).** Round 1 removed `RunCoderPayload.coderAdapterName`'s default (MEDIUM-3 in
  round 1), but docs/04's recovery-procedure example wasn't updated to match, so following it
  verbatim would hit a Zod validation error instead of recovering the stuck run. Fixed to include
  `coderAdapterName: 'CodexCoderAdapter'` (the production registry name) in the example.

**Post-implementation review fixes (round 3):**

- **HIGH-1 (`PlanActivatedPayloadSchema` required a field the real producer never emits).**
  `ActivatePlanHandler` emits `{ planId, projectId, activatedFeatureCount }`, but the schema
  required `featureRequestCount` — every real `plan.activated` event would fail
  `InboxProcessor.validateEventPayload()`. Round 2's `schemas.test.ts` missed this because it
  hand-built a payload using the schema's own (wrong) field name rather than checking against the
  actual producer. Fixed by renaming the schema field to `activatedFeatureCount` to match the
  producer (nothing else in the codebase depended on the old name). Round 2's schema-level test
  alone is not sufficient evidence a payload is real — `packages/testing/src/scenarios/
backlog-activation.ts` now also parses the actual emitted `plan.activated` outbox row against
  `EVENT_SCHEMAS['plan.activated']`, a producer-level regression test that would have caught this
  the first time.
- **MEDIUM-1 (blank pricing/prompt-template env vars bypassed validation).**
  `Number('')`/`Number('   ')` both evaluate to `0` in JavaScript, so round 2's
  `parsePriceEnvVar()` silently accepted a blank `CODE_GEN_PRICE_PER_1K_*_TOKENS` value as valid
  zero pricing instead of falling back to the default. Fixed by trimming and explicitly rejecting
  blank values (logs a warning, falls back to the default). Applied the same treatment to
  `CODER_PROMPT_TEMPLATE_VERSION` via a new `resolvePromptTemplateVersion()` helper, since a blank
  override would otherwise persist an empty-string `prompt_template_version` instead of the
  intended default. Tested in `run-coder.test.ts` for `''`/`'   '` on both env vars.
- **LOW-1 (two stale doc/comment inconsistencies from round 2's trust-boundary decision).**
  `codex-coder-adapter.ts`'s class-level comment still said the adapter "runs entirely inside" the
  sandbox, contradicting round 2's documented host-side LLM call. `docs/03`'s Phase 9
  implementation note incorrectly said `prompt_template_version` is "populated automatically by
  `AgentRunRecorder`'s `costExtractor` extension" — it is a separate, caller-supplied
  `RecordRunOptions` field unrelated to `costExtractor`. Both fixed to match the actual
  implementation.

**Post-implementation review fixes (round 4):**

- **LOW-1 (required runtime env vars were only truthiness-checked, not blank-rejected).**
  `GITHUB_TOKEN`/`CODE_GEN_BASE_URL`/`CODE_GEN_API_KEY`/`CODE_GEN_MODEL` used a bare `if (!value)`
  check in `resolveDefaultGithubClientFactory`/`resolveDefaultCoderAdapterFactory`, so a
  whitespace-only value passed validation and failed later with a less actionable error (e.g. an
  Octokit auth failure instead of a clear "not configured" message) — inconsistent with round 3's
  blank-rejection treatment of the pricing/prompt-version env vars. Fixed with a shared
  `requireNonBlankEnvVar()` helper, applied to all four required env vars. Tested in
  `run-coder.test.ts` for whitespace-only values on each var via the default (non-injected)
  adapter/GitHub-client factory path — including confirming the GitHub-client-factory case still
  surfaces as a logged, swallowed PR-creation failure (not a thrown/rejected task), consistent
  with the existing "PR-creation failure after a successful push is never re-thrown" contract.
- **LOW-2 (the `plan.activated` producer regression validated shape but not count semantics).**
  The round-3 fix parsed the real emitted outbox payload against `EVENT_SCHEMAS`, but Zod validates
  types, not values — a future regression that reported the wrong `activatedFeatureCount` (right
  type, wrong number) would still pass. Fixed by asserting in `backlog-activation.ts` that the
  parsed `activatedFeatureCount` equals the actual number of `feature_runs` rows the run produced.

**Post-implementation review fixes (round 5):**

- **LOW-1 (required env validation was fixed in `run-coder` but not centralized across sibling
  GitHub-facing tasks).** `github-reconciliation.ts`'s `resolveDefaultGithubClientFactory` still
  used a bare `if (!token)` truthiness check for `GITHUB_TOKEN`, while `run-coder.ts` had already
  moved to blank-rejecting validation — the same env var had two different validation contracts
  depending on which task read it. Fixed by extracting `requireNonBlankEnvVar()` out of
  `run-coder.ts` into a new shared `packages/triggerdev/src/tasks/env.ts`, adopted by both
  `run-coder.ts` and `github-reconciliation.ts`. Regression-tested in
  `github-reconciliation.test.ts` for whitespace-only `GITHUB_TOKEN` values via the default
  (non-injected) client-factory path, mirroring `run-coder.test.ts`'s existing coverage.
- **LOW-2 (the `plan.activated` count regression was still fixture-coupled).** Round 4's assertion
  (`activatedFeatureCount === featureRuns.length`) only holds because the `backlog-activation`
  fixture never seeds a preexisting `feature_runs` row — `ActivatePlanHandler` skips
  already-activated features (idempotent re-activation), so `activatedFeatureCount` means "newly
  inserted this call," not "final total row count," and a regression that reported the total
  instead of the delta would still have passed round 4's test. Fixed by seeding one preexisting
  `feature_runs` row in the scenario before activation and asserting
  `activatedFeatureCount === featureRuns.length - 1` (2 newly inserted of 3 total), which only
  passes if the handler's actual "skip already-activated" semantics are preserved.
- **LOW-3 (observability for pushed-but-no-PR runs) — explicitly deferred, not built.** The
  reviewer's third suggestion (a metric/alert for `code_pushed` runs with no PR after a grace
  period) is genuine future work, not a fix to land now — it requires new alerting/metrics
  infrastructure this repository doesn't have yet, the same category of item Phase 16
  ("observability") already owns elsewhere in this document. Recorded here rather than silently
  dropped.

## Reference Reviewer Adapter and Review/Fix Loop Operational Constraints (`packages/adapters-reviewer/`, `packages/core/src/review/`, migration 0011)

- **The Reviewer adapter needs no sandbox — a real simplification versus the Coder adapter
  (Phase 9).** Reviewing a pull request is read-only: fetch the diff via
  `GitHubClient.getPullRequestDiff()`, ask an LLM, return structured findings. `ClaudeReviewerAdapter`
  (`packages/adapters-reviewer`) calls its injected `ReviewProvider` (`HttpReviewProvider`, the one
  shipped implementation — a plain-`fetch` OpenAI-compatible client mirroring
  `HttpCodeGenerationProvider`'s shape) directly from the `run-review` Trigger.dev task process,
  with no container isolation to create/tear down and no egress-proxy allow-list to reason about.
- **A single aggregate `feature_runs.fix_attempt_count` counter (migration 0011), not per-finding/
  reopening granularity.** `FIX_ATTEMPT_THRESHOLD = 5`
  (`packages/core/src/domain/constants.ts`) is checked everywhere the feature-execution matrix
  requires a "fix-attempt count < threshold" guard: `RecordChangesRequestedHandler`
  (`under_review -> changes_requested`) and `RequestChangesAfterCiFailHandler`
  (`ci_failed -> changes_requested`) both increment it; `run-review.ts` and
  `reconcileGithubState()` both read it before deciding whether to dispatch a changes-requested
  command or escalate straight to `EscalateToHumanCommand`. docs/01 §5.8's finer-grained "two fix
  attempts per finding, one reopening of the same finding" limits are deliberately **not**
  implemented — this is a documented simplification, not an oversight; that granularity is future
  work, tracked but not built in this phase.
- **No `RecordApprovedByPolicyCommand` is dispatched on a clean review, from `run-review.ts` itself.**
  When `run-review.ts`'s normalized findings contain no `blocking` and no `requires_human_decision`
  entries, the task writes the (non-blocking/nit/question/out_of_scope) `review_findings` rows for
  audit and returns without any state transition — the feature run stays at `under_review`. At the
  time this was written there was no merge gate yet to block, so "non-blocking findings do not
  block merge" held because there was nothing downstream to block on yet.
  **Superseded by Phase 12:** the new, separately-triggered `run-merge-gate` task now provides the
  follow-up — it evaluates the real Merge Gate and dispatches `RecordApprovedByPolicyCommand` for
  any feature run it finds at `under_review`, including one left there by this clean-review path.
  `run-review.ts` itself still does not dispatch it directly (deliberately — see the Merge Gate and
  Branch Protection Operational Constraints section's "never inline" rule below).
- **Single normalization point: the task normalizes, the adapter does not.** `run-review.ts`
  always calls `@minicoder/core`'s `normalizeReviewerFindings()` on the raw `ReviewerOutput`
  returned by whichever adapter ran (`ClaudeReviewerAdapter` or a test `MockReviewerAdapter`) —
  neither adapter calls `normalizeReviewerFindings()` itself. This avoids a double-normalization
  split between adapter and task; `insertReviewFindings()`
  (`packages/core/src/review/write-findings.ts`) is a non-command evidence-data writer (the same
  category as `agent_context_packs`/`agent_tool_operations`), not a `CommandHandler` — it uses
  deterministic `review-finding:{featureRunId}:{reviewCycle}:{index}` ids with
  `ON CONFLICT (id) DO NOTHING` for idempotent retry, the same "insert-with-a-conflict-clause"
  posture `AdapterRegistry.register()` established for cross-dialect idempotency.
- **The exact reviewer prompt is persisted as a replayable audit snapshot (issue #49).**
  `ReviewProvider.review()`'s `ReviewResult` gained an optional `promptSnapshot: unknown` field
  (`HttpReviewProvider` populates it with the literal `{model, messages}` request body it POSTs);
  `ClaudeReviewerOutput extends ReviewerOutput` passes it through. `run-review.ts` writes it as a
  **second** `agent_context_packs` row keyed to the same `agentRunId` (distinct
  `content_schema_version = 'reviewer-prompt-snapshot-v1'`, alongside the PR's `head_sha` as the
  "which diff" reference — storing a commit reference rather than the diff itself, since
  `headSha` already identifies it without duplicating storage), redacted with the same
  `defaultRedactor.redactObject()` `AgentRunRecorder`'s own context-pack write already uses. This
  is a direct `db.execute()`, not routed through `AgentRunRecorder`, because `AgentRunRecorder`'s
  `contextPack` option is written **before** the wrapped adapter call runs, while the prompt
  snapshot is only knowable after it returns. A test double (`MockReviewerAdapter`) that doesn't
  report a `promptSnapshot` simply skips this write — no schema change, no required field.
- **`ci_failed`'s next-transition ownership stays inside `reconcileGithubState()`, not a separate
  caller.** Immediately after a successful `ci_running -> ci_failed` transition, the same bounded
  catch-up loop (`MAX_RECONCILE_STEPS`) reads the feature run's current `fix_attempt_count` and
  dispatches `RequestChangesAfterCiFailCommand` (below threshold) or `EscalateToHumanCommand`
  (`escalate-human-ci-limit:{featureRunId}`, at/over threshold) in the very same call — so both
  the webhook-triggered path (`packages/github/src/inbox-handlers.ts`) and the scheduled
  `github-reconciliation` task get this follow-up for free, matching this module's
  single-algorithm design (CLAUDE.md's GitHub Integration Operational Constraints above). This
  branch never needs the execution-lane lock — CI-outcome/review-outcome transitions are not
  lock-gated (see `requiresExecutionLock()`).
- **A pre-existing idempotency-key bug was fixed while touching this matrix row.** The
  `ci_failed -> changes_requested` row's `idempotencyKeyTemplate` was
  `changes-requested-after-ci:{featureRunId}` — no per-occurrence discriminator, even though this
  edge can recur across multiple CI-failure cycles for the same feature run (the same class of bug
  already fixed for `start-fixing`/budget-control keys in earlier phases). Fixed to
  `changes-requested-after-ci:{featureRunId}:{expectedVersion}`.
- **`RecordCiFailedHandler`'s blocking finding is written with `reviewer_run_id = NULL`.** A CI
  failure is not a `ReviewerAgentAdapter` invocation — there is no `agent_runs` row to attribute it
  to. `review_cycle` uses the run's current `fix_attempt_count + 1` so CI-failure findings
  interleave sensibly with reviewer-driven findings' cycle numbering.
- **`run-coder.ts`'s "optimistic fixed" coder-response write is a deliberate first-cut
  simplification.** On a successful fix-cycle push (feature run at `fixing`, not just `coding`),
  it writes one `coder_responses` row (`response_type='fixed'`) for **every** currently-unresolved
  `review_findings` row on that feature run — blocking and non-blocking alike — and marks each
  `resolved`, because `CoderOutput` (the shared, Phase-5-vintage adapter contract) carries no
  per-finding disposition today. A repeat*finding-style reviewer behavior on the \_next* review
  cycle inserts a **new** `review_findings` row (a new `review_cycle`) if an issue genuinely wasn't
  fixed, preserving history rather than reopening/re-flagging the already-resolved row. Do not
  read `resolved = 1` as "the coder adapter confirmed this specific finding was addressed" — it
  only means "a push happened while this finding was open."
- **`CODE_GEN_BASE_URL`/`CODE_GEN_API_KEY`/`CODE_GEN_MODEL` are reused for the reviewer LLM
  backend, not duplicated into a parallel `REVIEW_*` env-var family.** The default
  `ReviewerAdapterFactory` (`packages/triggerdev/src/tasks/run-review.ts`) reads the same three env
  vars `run-coder.ts` already reads, since the same OpenAI-compatible endpoint can serve both
  roles — simpler than introducing a second configuration surface. A deployment wanting a distinct
  reviewer model/endpoint can still inject a custom `ReviewerAdapterFactory` via `RunReviewDeps`
  instead of using this default.
- **`run-review.ts` is a separate, independently scheduled/triggered task from both `run-coder.ts`
  and `start-next-feature.ts` — never inline any of the three.** Same rationale as Phase 9's
  `run-coder.ts` (CLAUDE.md's Reference Coder Adapter Operational Constraints): keeps each task's
  concerns isolated and avoids adding new failure surface to `start-next-feature.ts`, which has
  already been through multiple rounds of concurrency-bug code review.

**Post-implementation review fixes (round 1):**

- **HIGH-1 (`run-review` was never registered as a Trigger.dev SDK task).** `run-review` was added
  to `ALL_TASK_IDS` with a real `runImpl`, payload schema, and tests, but
  `packages/triggerdev/src/triggerdev-tasks.ts` never imported it or called `task({ id: 'run-review',
... })` — a live deployment of this phase would therefore never register or schedule the reviewer
  task at all. Fixed by adding the import and `runReviewTask` registration, mirroring
  `runCoderTask`'s shape exactly. A new regression in `triggerdev.test.ts` statically scans
  `triggerdev-tasks.ts`'s source for a `task({ id: '<id>' })` registration matching every entry in
  `ALL_TASK_IDS`, so a future task-id addition without a matching registration fails a unit test
  instead of only surfacing in production.
- **HIGH-2 (the GitHub-human-review path in `reconcileGithubState()` could throw instead of
  escalating at the fix-attempt threshold).** The `under_review` + GitHub `changes_requested`
  branch dispatched `RecordChangesRequestedCommand` unconditionally; once
  `fix_attempt_count >= FIX_ATTEMPT_THRESHOLD` that handler throws `fix-attempt-limit-exceeded`
  (by design, as a defense-in-depth guard), which this caller did not catch — reconciliation would
  fail/retry instead of taking the matrix-required `under_review -> human_required` escalation,
  unlike the `ci_failed` branch immediately above it, which already checked the threshold first.
  Fixed by mirroring that branch: read `fix_attempt_count` before dispatch and escalate
  (`escalate-human-review:{featureRunId}`) instead of dispatching `RecordChangesRequestedCommand`
  when at/over threshold.
- **HIGH-3 (`run-review.ts` could strand a feature run at `changes_requested` on a lock-conflict
  retry).** After `RecordChangesRequestedCommand` succeeds, the task acquires the execution-lane
  lock to dispatch `StartFixingCommand`; if that acquire hit a transient race, the task returned a
  "successful" result without ever dispatching `StartFixingCommand`, and — because the top-of-task
  guard originally required `current_execution_state === UNDER_REVIEW` — a retry would see
  `CHANGES_REQUESTED` and immediately no-op, permanently stranding the feature run short of
  `fixing`. Fixed by making the task resumable: a feature run already at `CHANGES_REQUESTED` skips
  the reviewer invocation entirely (it was already reviewed) and retries only the
  `changes_requested -> fixing` hop, via a new shared `advanceToFixing()` helper used by both the
  fresh-review path and this resumed path.

**Post-implementation review fixes (round 2):**

- **HIGH-1 (`review_findings` were written before, not atomically with, the state transition they
  gate).** `run-review.ts` used to call `insertReviewFindings()` unconditionally right after
  normalizing the reviewer's output, in its own statement separate from whichever
  `RecordChangesRequestedCommand`/`EscalateToHumanCommand` dispatch followed. A crash between the
  two left blocking/`requires_human_decision` findings recorded against a feature run that never
  actually transitioned; a retry would then recompute `reviewCycle = MAX(review_cycle) + 1`,
  re-invoke the reviewer, and write a redundant cycle on top of the orphaned one. Fixed by passing
  `reviewerRunId`/`reviewCycle`/`findings` straight into the command payload for the
  blocking/escalation paths — `RecordChangesRequestedHandler` already accepted these (built but
  unused for this purpose in round 1); `EscalateToHumanHandler` gained the same optional fields —
  so both handlers now write the findings inside the same transaction as the state transition. Only
  the "approved, no transition to piggyback on" path still writes findings as a standalone call,
  since there's no command to attach them to. New atomicity regressions
  (`run-review.test.ts`, `review-write-findings.test.ts`) dispatch each handler with a deliberately
  stale `expectedVersion` and assert zero `review_findings` rows exist afterward, proving the
  rollback is total.
- **HIGH-2 (the same atomicity gap existed for `run-coder.ts`'s fix-cycle `coder_responses` write).**
  The "optimistic fixed" write (`coder_responses` + `review_findings.resolved`) happened in a
  separate transaction _after_ `RecordCodePushedCommand` had already committed `fixing ->
code_pushed`. A crash in that window left the push durably recorded but the findings it addressed
  still open forever — a retry no-ops since the run is no longer `coding`/`fixing`. Fixed by adding
  optional `coderRunId`/`resolvedFindingIds` fields to `RecordCodePushedCommand`'s payload;
  `RecordCodePushedHandler` now performs the `coder_responses` insert and `review_findings.resolved`
  update inside its own transaction, immediately after the state update succeeds. A new atomicity
  regression (`review-write-findings.test.ts`) forces an `OptimisticLockError` via a stale
  `expectedVersion` and asserts no `coder_responses` row and no `resolved` flip occurred.
- **WATCH (deferred, not fixed): `advanceToFixing()`'s transient lock-conflict path still returns
  a "successful" `decision: 'changes_requested'` without itself retrying `StartFixingCommand`.**
  This is intentional, not an oversight: the `run-review.ts` guard added in round 1 already makes a
  feature run stranded at `CHANGES_REQUESTED` resumable on the _next_ invocation of this task (a
  later scheduled/opportunistic call, not a synchronous in-process retry) — the design already
  documented in round 1's HIGH-3 fix. Making `advanceToFixing()` itself fail/retry synchronously
  would just convert a routine, already-recoverable lock contention into a thrown task failure for
  no added safety.

**Post-implementation review fixes (round 3):**

- **HIGH (bare integer literals against `review_findings.resolved`, a PostgreSQL `BOOLEAN`
  column).** `insertReviewFindings()` (`0` on insert), `run-coder.ts`'s open-findings query
  (`resolved = 0`), and `RecordCodePushedHandler`'s resolve-on-fix-push update (`resolved = 1`) all
  used bare integer literals. SQLite accepts this (no real boolean type — stored as `INTEGER`), but
  real PostgreSQL rejects it outright (`column "resolved" is of type boolean but expression is of
type integer` on insert/update; `operator does not exist: boolean = integer` on the `WHERE`
  clause) — confirmed against a live PostgreSQL 16 instance, not just inferred from the schema.
  Fixed by switching all three sites to the `FALSE`/`TRUE` SQL keywords, which both SQLite (3.23+)
  and PostgreSQL accept identically. New Postgres-backed regression
  (`packages/migrations/src/review-findings.postgres.test.ts`, gated by `MINICODER_TEST_PG_URL`
  like the existing `runner.postgres.test.ts`/`registry.postgres.test.ts`) applies the real
  migrations against a live PostgreSQL schema and round-trips `insertReviewFindings()` →
  open-findings query → `RecordCodePushedHandler`'s resolve path — reverting the fix reproduces
  the exact `42804`/`column is of type boolean` errors this regression now catches.
- **MEDIUM (deferred at the time, later closed by issue #46): the clean-review (no-transition)
  path's `insertReviewFindings()` call was still a standalone write, not wrapped in a
  caller-level idempotency guard.** Unlike the blocking/escalation paths (round 2's HIGH-1 fix),
  there's no state transition here to make the write atomic with — a crash/retry in this window
  could mint a new `reviewCycle` and duplicate audit-only (non-blocking) findings. **Closed by
  issue #46:** migration `0012_review_occurrence_markers` adds a `review_occurrence_markers` table
  (`packages/core/src/review/occurrence-marker.ts`'s `findReviewOccurrenceMarker()`/
  `recordReviewOccurrenceMarker()`) keyed by `(feature_run_id, head_sha)` — the PR's head commit
  already uniquely identifies "which diff was reviewed," so it needs no running `MAX()` count.
  `run-review.ts` now checks it **before** invoking the reviewer adapter at all: if the current PR
  head has already been recorded, the task returns the prior outcome without re-invoking the
  adapter or minting a new cycle. Both clean-review write sites (the plain "no blocking findings"
  path, and the "Arbiter dismissed every blocking finding this cycle" path) now insert the marker
  in the same `db.transaction()` as `insertReviewFindings()`, so a crash between the two can't
  leave one without the other.
- **MEDIUM (deferred at the time, later closed by issue #47): `ClaudeReviewerAdapter` synthesized a
  placeholder feature title and empty acceptance criteria.** `ReviewerInput` (the shared Phase-5
  adapter contract) carried no such fields. **Closed by issue #47:** `ReviewerInput` gained
  optional `featureTitle`/`acceptanceCriteria` fields, mirroring `CoderInput`'s shape (additive,
  backward-compatible — existing callers/mocks that don't set them keep compiling).
  `run-review.ts` now queries the real feature title/acceptance criteria (the same
  `feature_requests`/`acceptance_criteria` query `run-coder.ts` already uses) and populates them;
  `ClaudeReviewerAdapter` uses the real values when present, falling back to the old placeholder
  only when a caller-supplied `ReviewerInput` omits them (e.g. an older test fixture).

**Post-implementation review fixes (round 4):**

- **HIGH-1 (a `changes_requested` run — whether CI-failure-originated or human-review-originated
  — had no path to `fixing`).** `run-review.ts`'s `advanceToFixing()` only ever resumes a run that
  IT itself put at `changes_requested` (the AI-reviewer path); a CI-failure-driven or
  GitHub-human-review-driven `changes_requested` had no caller at all driving the
  `changes_requested -> fixing` hop, so a feature run below the fix-attempt threshold could get
  permanently stuck — and the `review-fix-loop` scenario's CI-failure case locked in that stuck
  state as "correct" (`current_execution_state === 'changes_requested'`). Fixed by adding a
  `CHANGES_REQUESTED` branch to `reconcileGithubState()` itself (not a separate task) that
  dispatches `StartFixingCommand` — firing uniformly regardless of how the run reached
  `changes_requested`, matching this module's single-algorithm design. `requiresExecutionLock()`
  now includes `CHANGES_REQUESTED` (this branch needs the lock, like `CODE_PUSHED`/`PR_OPENED`);
  `github-reconciliation.ts`'s `EXPECTED_COMMAND_ERROR_TYPES` gained `automation-paused` since
  `StartFixingCommand` can now throw it per-candidate (a routine, skip-this-candidate condition,
  not a reason to abort the batch). This is a deliberate behavioral change to an already-tested
  invariant: a reconcile pass on an unchanged `changes_requested` run previously no-opped
  (`action: 'none'`); it now actively retries the `-> fixing` hop every time (reporting
  `lock_required` until a lock is supplied) — five existing `github-reconcile.test.ts` tests were
  updated to reflect this, and `seedFeatureRun()`'s fixture now seeds a `workflow_states` row
  (`automation_state = 'running'`) since `StartFixingHandler`'s guard requires one, matching a real
  production feature run's actual invariants. The `review-fix-loop` scenario's CI-failure case
  (and its fixture) now acquires a real `ExecutionLane` lock and asserts the run reaches `fixing`.
- **HIGH-2 (`pull_requests.conversations_resolved` had the same bare-integer-literal bug fixed for
  `review_findings.resolved` in round 3, but was missed).** `insertPullRequestRow()`'s `UPDATE`
  (`conversations_resolved = 0`) and `INSERT` (positional `0`) both write into a PostgreSQL
  `BOOLEAN` column (migration 0009) via raw SQL literals — the identical cross-dialect issue,
  just in a different table. Fixed to `FALSE`. Note: `syncPullRequestObservedState()`'s own
  `conversations_resolved`/`mergeable` writes were NOT touched — those already pass a JS
  `0`/`1` as a _bound parameter_ (`?` placeholder), not an inline SQL literal, and a bound
  integer parameter against a PostgreSQL `BOOLEAN` column is accepted (confirmed empirically
  against a live PostgreSQL 16 instance) — only bare literals parsed directly by PostgreSQL's SQL
  parser lack an implicit integer-to-boolean cast.
- **MEDIUM (`RecordCodePushedHandler` trusted `resolvedFindingIds` without scoping to the current
  feature run).** A bad or future caller passing a finding id from a different feature run would
  have resolved it and written a `coder_responses` row for it. Fixed by scoping the
  `review_findings` resolve-`UPDATE` with `AND feature_run_id = ?` and using its affected-row count
  to gate whether the `coder_responses` row is even written — a mismatched id is now silently
  skipped rather than acted upon. Defense-in-depth only: `run-coder.ts`'s current caller already
  derives every id from `review_findings WHERE feature_run_id = ?`, so this was never an observed
  breakage.
- **LOW (`@minicoder/adapters-reviewer` was missing from `vitest.config.ts`'s alias map).** Added,
  matching the pattern used for every other workspace package that tests resolve directly from
  source rather than `dist/`.

**Post-implementation review fixes (round 5):**

- **Issue #48 (`run-review.ts` and `github-reconciliation.ts` handled `automation-paused`
  inconsistently on the same `StartFixingCommand` dispatch).** Round 4's `github-reconciliation.ts`
  fix (above) added `automation-paused` to that file's `EXPECTED_COMMAND_ERROR_TYPES`, but
  `run-review.ts`'s own `advanceToFixing()` helper — which dispatches the identical
  `StartFixingCommand` for the identical `changes_requested -> fixing` hop — still used a narrower
  set (`concurrent-command`/`not-found` only), so a pause landing at that exact moment would throw
  out of the task instead of being swallowed. Not a correctness bug (the `changes_requested`
  transition is already durably recorded by that point, so a thrown task failure just meant
  Trigger.dev retry, or a later `github-reconciliation` pass would pick up the `-> fixing` hop via
  its own `CHANGES_REQUESTED` branch) — but the two callers of the same command behaved differently
  for the same condition, which is confusing to reason about and easy to regress. Fixed by adding
  `automation-paused` to `run-review.ts`'s `EXPECTED_COMMAND_ERROR_TYPES` too, so both callers now
  swallow it identically. Regression in `run-review.test.ts` pauses automation mid-flight and
  asserts the task returns `decision: 'changes_requested'` without throwing, with the feature run
  left at `changes_requested` (not `fixing`) since only the `-> fixing` hop was skipped.

## Disagreement, Arbiter, and Human Escalation Operational Constraints (`packages/core/src/disagreement/`, `packages/core/src/commands/handlers/feature/{resolve-disagreement,resume-feature-execution,retry-feature,skip-feature,block-feature}.ts`)

- **`human_required` had zero outgoing transitions before this phase.** Five new matrix rows give
  it five exit commands, matching docs/00 §3.3's "resolve, retry, skip, block, or resume"
  vocabulary exactly: `ResolveDisagreementCommand` (→ `changes_requested`, requires an open/
  escalated `disagreement_records` row), `ResumeFeatureExecutionCommand` (→ `under_review`, no fix
  needed), `RetryFeatureCommand` (→ `selected`), `SkipFeatureCommand` (→ `skipped`, new terminal
  state), `BlockFeatureCommand` (→ `blocked`, human-initiated). All five are actor=`approver`.
- **"Repeated unresolved finding" detection compares description text across review cycles,
  because there is no other repeat signal — and is scoped to `blocking` severity only.**
  `findRepeatedFinding()` (`packages/core/src/disagreement/detect.ts`) matches a current `blocking`
  finding's exact (trimmed) description against `review_findings` from an earlier `review_cycle`
  for the same feature run. This is necessary, not merely convenient: Phase 10's "optimistic fixed"
  `RecordCodePushedHandler` design resolves every currently-open finding on any push, so a problem
  the coder didn't actually fix never shows up as the same row reopened — it shows up as a
  brand-new row in a later cycle with the same text. There is no per-finding fingerprint/hash
  column to match on instead. **`requires_human_decision` findings are excluded, not merely an
  oversight:** `run-review.ts`'s `hasRequiresHumanDecision` branch escalates that severity to
  `human_required` unconditionally and returns before `findRepeatedFinding()` is ever called — a
  code-review round caught an earlier draft where the doc comments claimed
  `requires_human_decision` was included in repeat detection while the control flow made that
  unreachable. Fixed by narrowing the detector to `blocking` only and documenting why: the Reviewer
  itself already decided this needs a human, and the Arbiter's role is resolving a coder/reviewer
  disagreement over a recurring `blocking` finding, not second-guessing that decision.
- **The fix-attempt-threshold circuit breaker is checked before disagreement detection, and the
  Arbiter cannot override it.** `run-review.ts`'s `hasBlocking` branch still checks
  `fix_attempt_count >= FIX_ATTEMPT_THRESHOLD` first and escalates unconditionally if so — matching
  docs/01 §5.8/§5.9's framing that the review-cycle limit and the Disagreement Manager are
  independent circuit breakers. Disagreement detection only runs in the branch below that check.
- **A caller-supplied `disagreementId` on `ResolveDisagreementCommand`/
  `ResumeFeatureExecutionCommand` is never trusted bare.** An initial cut accepted it and passed it
  straight to `resolveDisagreementByHuman()` with no existence/ownership check — a bogus id
  silently updated 0 rows (query mismatch) while the feature run's state transition proceeded
  anyway, and a valid id belonging to a _different_ feature run's disagreement would actually
  mutate that other record. Fixed with `findDisagreementForFeatureRun()`
  (`packages/core/src/disagreement/write.ts`), which scopes the lookup to
  `id + feature_run_id + state IN (open, escalated)` before either handler proceeds, and
  `resolveDisagreementByHuman()` now also scopes its `UPDATE` by `feature_run_id` and returns the
  affected-row count so both handlers reject (409 `no-open-disagreement`) rather than silently
  no-op when the count is 0.
- **No `run-arbiter` Trigger.dev task was added.** Unlike Coder (`run-coder`) and Reviewer
  (`run-review`), which are each independently scheduled/triggered tasks per the "never inline"
  rule elsewhere in this document, the Arbiter is invoked inline inside the same `run-review.ts`
  task invocation that produced the reviewer output being arbitrated — arbitrating a disagreement
  is a sub-decision within processing this one review cycle's output, not an independently
  dispatchable unit of work the way a full Coder or Reviewer run is.
- **`ArbiterAgentAdapter` has no reference implementation, so `run-review.ts` never constructs one
  from env.** `RunReviewDeps.arbiterAdapterFactory` must be injected by the caller — the same
  posture Phase 6 established for `PlannerAgentAdapter` in `planning-readiness-assessment`/
  `generate-implementation-plan` before any reference planner adapter existed. A live deployment
  that reaches a disagreement without one configured throws an actionable error rather than
  silently skipping arbitration or falling through to escalation.
- **The Arbiter's `resolution` maps to three different outcomes, not a binary
  resolve/escalate.** `reviewer_correct`/`compromise` continue the ordinary fix loop unchanged
  (the finding stays blocking). `coder_correct` downgrades the matching finding to `non_blocking`
  in the in-memory findings array before insertion (not deleted — it stays in `review_findings` for
  audit) and, if nothing else in the cycle is still blocking, the feature run returns to
  `under_review` instead of `changes_requested`. `escalate_to_human` reuses the exact same
  `dispatchEscalation()` helper the pre-Phase-11 threshold-exceeded path already used.
- **`disagreement_records.state` has three values with two different "still open" meanings.**
  `open` (never arbitrated) and `escalated` (the Arbiter pushed it to a human, who hasn't
  dispositioned it yet) are both still-unresolved from a human-resolution caller's point of view —
  `findOpenDisagreement()`/`resolveDisagreementByHuman()` both match `state IN ('open',
'escalated')`, not `state = 'open'` alone. Only `resolved` (set by either
  `recordArbiterDisposition()` or `resolveDisagreementByHuman()`) is terminal.
- **`RetryFeatureCommand` re-checks `workflow_states.active_feature_run_id === featureRunId`
  before allowing `human_required → selected`.** Retrying a feature run that isn't the project's
  current active feature would leave it at `selected` with no `active_feature_run_id` pointer to
  it — neither `SelectFeatureHandler`'s compare-and-swap nor `start-next-feature`'s
  stranded-selected-run check would ever discover it again, silently orphaning the run. This is the
  same class of invariant-preservation guard `start-next-feature.ts`'s several concurrency-bug
  fixes already established for this column (Execution Orchestrator Operational Constraints
  above) — do not remove it to "simplify" a retry.
- **`SkipFeatureCommand`/`BlockFeatureCommand` clear `workflow_states.active_feature_run_id` when
  the feature run being dispositioned is the active one**, mirroring `RecordMergedCommand`'s
  `clear_active_feature_run` side effect — otherwise `start-next-feature` would never select a
  different feature for the project again. `ResolveDisagreementCommand`/
  `ResumeFeatureExecutionCommand` correctly do **not** clear it — the feature run stays active,
  just at a different execution state.
- **A human-initiated `blocked` (via `BlockFeatureCommand`) has no matching human-initiated
  unblock — this is a known, documented limitation, not an oversight.**
  `UnblockFeatureCommand`'s guard (Phase 8) checks `feature_dependencies`, not "a human said this
  is unblocked now"; a feature blocked this way with no unmet dependency will never satisfy that
  guard automatically. Recovering it currently requires `minicoder state repair`. `RetryFeatureCommand`
  is not reachable from `blocked` either (its `fromState` is `human_required` only) — this is the
  same "handler exists, full recovery path lands later" posture Phase 8 already left
  `UnblockFeatureHandler` in for several phases.
- **`SKIPPED` is a new terminal `FeatureExecutionState`, added to the glossary before use** (per
  the glossary's own "no new state without adding it to docs/00 first" rule). A `skipped` feature
  never reaches `merged`, so any downstream feature depending on it via `feature_dependencies` will
  never see its dependency guard clear automatically — a documented, not solved, consequence of a
  deliberate human decision (the same posture this document already applies elsewhere).
- **`minicoder human ...` is the first CLI surface to dispatch a real state-machine command
  directly**, via `TransactionalCommandExecutor`, rather than only reading state (`state inspect`)
  or writing simulated inbox events (`github simulate-*`). A one-shot human disposition has no
  async/durable-retry need that would justify a Trigger.dev task, so this is a synchronous CLI
  action against the DB, using the pre-existing `humanActor()` helper
  (`packages/triggerdev/src/tasks/actor.ts`) to build the acting human's `ActorIdentity`.
- **`human_approvals` and `disagreement_records` get their first production writers in Phase 11.**
  Both tables existed unwritten since the Phase 1 initial schema (43-table migration) — the same
  "created-but-unwritten" pattern `cost_records`/`agent_context_packs` followed before Phase 8/9.
  No migration was needed: both tables' columns (plain `TEXT`, no `CHECK` constraints) already
  accommodated every value this phase writes, including the new `human_escalation_resolution`
  `human_approvals.context_type` convention for dispositions unrelated to a specific disagreement.

## Merge Gate and Branch Protection Operational Constraints (`packages/core/src/merge-gate/`, `packages/core/src/commands/handlers/feature/{record-approved-by-policy,merge-if-ready,record-merged,record-merge-failed,reconcile-merge-failed}.ts`)

- **`merge_gate_evaluations`, `RecordApprovedByPolicyCommand`, `MergeIfReadyCommand`,
  `RecordMergedCommand`, `RecordMergeFailedCommand`, and `ReconcileMergeFailedCommand` all existed
  since Phase 2/Phase 1 — Phase 12 is "give these already-defined matrix rows and this
  already-defined table their first real implementation," the same posture Phase 6/7/8/9/10
  already established for other rows built ahead of their handler.** No new migration: the
  `merge_gate_evaluations` table (43-table initial schema) and `pull_requests` (migration 0009)
  already had every column this phase needs.
- **`evaluateMergeGate()` writes its evidence row in a transaction _separate_ from the state
  transition it gates — not one atomic unit.** A single all-or-nothing transaction covering both
  would roll the `merge_gate_evaluations` INSERT back along with a deliberately-not-taken
  transition whenever the gate rejects, silently losing the audit trail for exactly the runs where
  "every merge-gate run writes a structured record" (docs/01 §12) matters most. Both
  `RecordApprovedByPolicyHandler` and `MergeIfReadyHandler` are two-phase: phase one opens its own
  transaction, evaluates the gate, and always commits the evidence row (unless the feature run
  itself doesn't exist — nothing to write evidence against); phase two only runs when the
  evaluation passed, and is the one that claims the idempotency key and performs the actual
  transition. A rejected evaluation throws `CommandError({ type: 'merge-gate-blocked' })` after
  phase one commits — the caller (`run-merge-gate.ts`, `minicoder merge merge-if-ready`) catches
  this specific type as an expected "not ready yet" outcome, not an infrastructure failure. Retries
  after a rejection re-run phase one (a fresh, harmless evidence row — `merge_gate_evaluations` has
  no unique key, same append-only-audit-log posture as `adapter_conformance_results`), not a stale
  cached result.
- **`evaluateBudget()`'s parameter type was widened from `DbClient` to `TxClient`** (it only ever
  calls `.query()`, never opens its own transaction) so `evaluateMergeGate()` can call it from
  inside a caller-supplied transaction. Every existing Phase 8 call site passing a full `DbClient`
  still type-checks (`DbClient extends TxClient`) — this is a pure widening, not a behavior change.
- **`evaluateMergeGate()` deliberately never reads `pull_requests.conversations_resolved`.** That
  field has been a hardcoded `false` placeholder since Phase 7 (GitHub REST has no "conversations
  resolved" flag; GraphQL support is tracked in issue #36) — gating on a permanently-`false` value
  would make every real merge permanently blocked. The Phase 7 architectural fitness test
  `no-conversations-resolved-gate.test.ts` was **not modified**: `evaluate-merge-gate.ts` is not on
  its `ALLOWED_BASENAMES` allow-list, so any future change wiring this field into the gate must
  edit that test's allow-list as a visible, deliberate decision, not a silent one. Real
  conversation-resolution enforcement is tracked, real future work, not silently dropped.
- **Blocking labels are a single, deployment-wide policy, not a per-project policy table.**
  `resolveBlockingLabelsPolicy()` (`packages/core/src/merge-gate/constants.ts`) reads
  `MERGE_GATE_BLOCKING_LABELS` (comma-separated, case-insensitive) via `EnvConfigBackend` — never
  bare `process.env` (core's `no-restricted-syntax` ESLint rule forbids that outside
  `config/secrets.ts`/`config/config.ts`) — defaulting to `do-not-merge`/`wip`/`blocked`.
  `pull_requests.blocking_labels` (Phase 7) is unchanged: it still mirrors every label GitHub
  reports, with no per-project filtering at the observation layer; the policy filtering happens
  only in the gate.
- **"Branch protection / mergeability" is derived from the observed `pull_requests.mergeable`
  flag, not a separate GitHub branch-protection-rules API call.** GitHub's own mergeability
  computation already accounts for required status checks and branch-protection rules.
  `minicoder github simulate-branch-protection-ok` (Phase 7 dev-tooling, writes a
  `branch.protection_ok` inbox event with a no-op handler) remains exactly that — dev-tooling only,
  never consumed by the gate.
- **"Required human approvals exist" is evaluated as "no outstanding `rejected`/`deferred`
  `human_approvals` row for this feature run," not a new approval type minted for the merge-if-ready
  invocation itself** — docs/01 §12 is explicit that "required human approvals exist" refers to
  upstream approvals (assumption acceptance, budget override, etc.), not to the merge-if-ready
  action. `insertHumanApproval()`'s doc comment already anticipated a `merge_gate` `context_type`
  value for this table; no schema change was needed.
- **A pre-existing idempotency-key bug was fixed on two matrix rows while giving them their first
  real handler.** `record-merge-failed:{featureRunId}` and `reconcile-merge-failed:{featureRunId}`
  (both defined in Phase 2) lacked an `{expectedVersion}` discriminator — the same class of bug
  already fixed for `start-fixing`/budget-control keys in earlier phases. A feature run can cycle
  through `merge_failed` more than once (an auto-cleared failure returns to `under_review`, which
  can reach `merge_ready` and fail again); a key scoped to `{featureRunId}` alone would replay the
  first failure's cached result for every later one within the idempotency TTL. Fixed to
  `record-merge-failed:{featureRunId}:{expectedVersion}` / `reconcile-merge-failed:{featureRunId}:
{expectedVersion}`.
- **`merge_ready -> human_required` reuses the existing, already-generic `EscalateToHumanHandler`
  — no new handler was added for it.** `EscalateToHumanCommand` has resolved every non-terminal
  `fromState` via `StateTransitionValidator`'s matrix lookup since the Phase 7 code-review round
  that extended its matrix coverage to all 14 non-terminal states; `merge_failed -> human_required`
  is simply another matrix row that same handler already satisfies.
- **`GitHubClient.mergePullRequest()` (Phase 12) is the first GitHub-facing method whose real
  implementation classifies HTTP status codes into a typed, caller-actionable error
  (`GithubMergeRejectedError`) rather than an opaque rethrow.** `OctokitGitHubClient`'s
  classification: 409 (the PR's real head has moved past the caller-supplied `expectedHeadSha`,
  i.e. someone pushed after the gate re-evaluated) → `reason: 'sha_mismatch'`,
  `autoClearable: true`; 405 (covers both branch-protection rejection and a real merge conflict —
  GitHub's response does not distinguish the two) → `reason: 'not_mergeable'`,
  `autoClearable: false`; any error with **no** HTTP status (a genuine infrastructure/auth failure,
  not a merge-gate rejection at all) is rethrown as the original error, not wrapped — misclassifying
  an infra failure as a routine merge rejection would incorrectly drive a `RecordMergeFailedCommand`
  state transition for something that isn't actually a merge-gate outcome.
- **A GitHub merge-rejection is recorded via `RecordMergeFailedCommand`, then a _separate_ explicit
  follow-up command (`ReconcileMergeFailedCommand` or `EscalateToHumanCommand`) — never inferred
  automatically inside `RecordMergeFailedHandler` itself.** The handler stays pure state-transition
  logic (matching the established `RecordBudgetExceededHandler`/`RecordChangesRequestedHandler`
  convention of not deciding what happens next); the caller (`minicoder merge merge-if-ready`, the
  only production caller of `GitHubClient.mergePullRequest()`) already has the
  `GithubMergeRejectedError.autoClearable` classification in hand and dispatches the matching
  follow-up command in the same invocation.
- **`publishMergeGateStatusCheck()` is the first production caller of
  `GitHubClient.publishStatusCheck()`**, which existed on the `GitHubClient` interface unwritten
  since Phase 7. Two call sites publish it: the new `run-merge-gate` Trigger.dev task (after
  `RecordApprovedByPolicyCommand`, win or lose) and `minicoder merge merge-if-ready` (after its own
  re-evaluation, win or lose, and again is not reached if the initial re-gate already rejected).
  A status-check publish failure is logged and swallowed, never thrown — mirrors `run-coder.ts`'s
  established "PR-creation failure after a successful push is never re-thrown" contract: the state
  transition (or lack of one) this status check merely reports is already durably recorded by the
  time the publish is attempted, so a transient GitHub API hiccup here is not a reason to fail the
  task/command.
- **`run-merge-gate` (18th canonical Trigger.dev task ID) is a separate, independently
  scheduled/triggered task from `run-review.ts`/`run-coder.ts`/`start-next-feature.ts` — never
  inlined into any of them**, matching this document's established "never inline" rule for
  GitHub-facing/execution tasks. It is the operator-triggered "recompute merge gate" action
  (docs/00 §4.4's `operator` capability list) and the follow-up Phase 10 left unbuilt: a clean
  review leaves a feature run at `under_review` with no automatic next step ("Phase 12's Merge Gate
  owns that transition" — `run-review.ts`'s doc comment). It is safe to invoke repeatedly/on a
  schedule: a feature run not at `under_review` is a clean no-op, and every real invocation writes
  a fresh `merge_gate_evaluations` audit row regardless of outcome.
- **`minicoder merge merge-if-ready` is the second CLI surface (after `minicoder human ...`) to
  dispatch real state-machine commands directly via `TransactionalCommandExecutor`**, for the same
  reason: a human-approved merge action has no async/durable-retry need that would justify a
  Trigger.dev task. Unlike `minicoder human ...`, this command also makes a real external API call
  (`GitHubClient.mergePullRequest()`) partway through — the command sequence is deliberately
  ordered so that call only happens _after_ `MergeIfReadyCommand`'s re-gate has already durably
  committed the `merge_ready` transition, so a crash between the GitHub call and recording its
  outcome leaves the feature run at a real, recoverable `merge_ready` state (a human can re-run
  `merge-if-ready`, which re-gates again) rather than silently accepting a merge no local state
  reflects.

**Post-implementation review fixes (round 1):**

- **HIGH-1 (`approved-by-policy`/`merge-ready` idempotency keys were not `{expectedVersion}`-scoped).**
  `under_review -> approved_by_policy` and `approved_by_policy -> merge_ready` can each recur for
  the same feature run (e.g. after a `merge_failed` auto-clear returns it to `under_review` and it
  is re-approved) — a key scoped to `{featureRunId}` alone would replay the _first_ occurrence's
  cached `CommandResult` for every later one within the idempotency TTL, most dangerously letting
  `minicoder merge merge-if-ready` proceed to the real GitHub merge call against a run that never
  actually re-transitioned to `merge_ready` this time. Fixed both matrix templates and their
  callers (`run-merge-gate.ts`, `merge.ts`) to `...:{featureRunId}:{expectedVersion}`; added a
  `run-merge-gate.test.ts` regression that cycles a run back to `under_review` at a later version
  and asserts it is genuinely re-approved rather than replaying stale state.
- **HIGH-2 (`OctokitGitHubClient.mergePullRequest()` misclassified every non-409/405 HTTP status as
  a merge-gate rejection).** The doc comment already claimed infra/auth failures were rethrown
  as-is, but the code wrapped any status other than 409/405 — including 401/403/404/422/429/5xx —
  into `GithubMergeRejectedError('unknown', false)`, which the CLI's catch block would then record
  as `RecordMergeFailedCommand` + `EscalateToHumanCommand`, misrepresenting a transient operational
  failure (bad credentials, rate limiting, a GitHub outage) as a genuine merge-policy rejection.
  Fixed to only classify 409/405; every other status (or none) is rethrown untouched. Added
  parameterized tests covering 401/403/404/422/429/500/503.
- **MEDIUM-1 (the CLI didn't swallow status-check publish failures the way the Trigger.dev task
  does).** `run-merge-gate.ts`'s `publishStatusCheckSafely` logs-and-swallows a
  `publishMergeGateStatusCheck()` failure so a transient commit-status API hiccup can't abort an
  already-durable state transition; `minicoder merge merge-if-ready` originally `await`ed the same
  call directly, so the identical hiccup could throw between a rejected-gate response (or a
  successful `merge_ready` transition) and the caller ever seeing a result. Fixed by adding the same
  safe wrapper to the CLI. Also added a defense-in-depth re-check that the feature run is genuinely
  at `merge_ready` immediately before the real GitHub merge call (redundant with the HIGH-1 fix, but
  cheap insurance against a future caller reusing this code path differently).
- **MEDIUM-2 (blocked-gate reasons were reconstructed by parsing `CommandError.problem.detail`
  prose).** `run-merge-gate.ts` used to recover the structured reasons array via
  `detail.split(': ').slice(1).join(': ').split('; ')` — fragile, and would silently corrupt if a
  reason's own text ever contained those delimiters. Replaced with `MergeGateBlockedError`, a typed
  `CommandError` subclass carrying `reasons: string[]` directly; both `RecordApprovedByPolicyHandler`
  and `MergeIfReadyHandler` throw it, and both callers read `.reasons` structurally.
- **LOW-1 (a stale doc comment on `evaluateMergeGate()` described one-transaction atomicity).** The
  comment hadn't been updated when the handlers moved to the two-phase evidence-then-transition
  design; fixed to describe the actual contract.

**Post-implementation review fixes (round 2):**

- **MEDIUM-1 (`escalate-human-merge-failed` had the same un-scoped idempotency key bug as round 1's
  HIGH-1, just on a row round 1 didn't touch).** `merge_failed -> human_required` can recur for the
  same feature run across separate merge-failure cycles (`merge_failed -> human_required ->
under_review -> approved_by_policy -> merge_ready -> merge_failed`, repeated); a key scoped to
  `{featureRunId}` alone would replay the first escalation's cached result on a later
  non-auto-clearable failure without transitioning the current `merge_failed` row, while the CLI
  still reported `resolution: 'human_required'`. Fixed the matrix template and the CLI call site to
  `escalate-human-merge-failed:{featureRunId}:{expectedVersion}`; added a scenario regression
  forcing a second non-auto-clearable failure and asserting it re-escalates.
- **HIGH-1 (`evaluateMergeGate()` didn't enforce three of docs/01 §12's documented hard
  preconditions).** "Belongs to the active feature," "PR is open," and "targets the correct base
  branch" were absent — a stale or wrong-base PR, or a feature run that wasn't actually the
  project's active one, could otherwise slip through a drift/repair/race case even when every other
  mirrored predicate looked green. Fixed by checking `workflow_states.active_feature_run_id ===
featureRunId`, `pull_requests.state === 'open'`, and `pull_requests.base_branch ===
repositories.default_branch`. "Matches the database branch record" needed no new check — it's
  satisfied by construction, since the evaluator only ever loads the one `pull_requests` row
  tracked for `featureRunId`; there is no other branch record a wrong PR could diverge from.
  **This required reworking the `merge-gate` test scenario**, which had deliberately kept four
  feature runs simultaneously `under_review`/`approved_by_policy` in one project for test
  convenience — a setup that itself violated the real one-active-feature-per-project invariant
  (Phase 8) the new check enforces. The scenario now explicitly hands `active_feature_run_id` off
  between cases as each is evaluated, matching how the orchestrator actually behaves in production,
  rather than a testing-only shortcut. Added three new `run-merge-gate.test.ts` regressions
  (not-active, PR-closed, wrong-base-branch).

**Round 3 (clean re-review — no findings; two non-blocking watchlist notes, not fixed):**

- A final PR/repository re-fetch immediately before `mergePullRequest()` was suggested as extra
  defense-in-depth against a same-head PR retarget race. Not implemented: GitHub's own `sha`
  parameter on `pulls.merge` is itself an optimistic-concurrency check against the PR's real
  current head, so the described race is already covered by the existing `sha_mismatch`
  classification (HIGH-2 above) — a same-head retarget without a new commit is not a scenario
  `sha` alone would catch, but is also not a realistic GitHub state transition (retargeting a PR
  does not change its head SHA, and the base-branch predicate added in round 2 already rejects a
  PR that isn't targeting the repository's default branch).
- The base-branch predicate's `repositories WHERE project_id = ? LIMIT 1` query assumes one
  repository per project. Not changed: every other repository lookup in this codebase
  (`run-review.ts`, `run-coder.ts`, `github-reconciliation.ts`) already makes the identical
  assumption — this predicate does not introduce new row-order fragility, it inherits an existing,
  deployment-wide invariant. Enforcing "one repository per project" as a real constraint (or
  linking a PR to a canonical repository row) is future schema work, not a Phase 12 gap.

## Orchestrator API Operational Constraints (`packages/api/`)

- **Auth is a static, env-config-driven API-key map — there is no session/JWT infra anywhere in
  this repository.** `MINICODER_API_KEYS` is a JSON array of `{key, id, role, actorKind,
displayName?}`; `ApiKeyProvider` hashes each key with SHA-256 at boot and never stores or
  compares raw key material, so a leaked log line can't leak a usable credential. Requests
  authenticate via `Authorization: Bearer <api-key>`; the resolved identity is placed on
  `request.actor: ActorIdentity` by a global `onRequest` hook (`auth/middleware.ts`), which every
  route downstream (read, command, or diagnostic) relies on being already populated. `LocalAuthProvider`
  (`packages/core/src/auth/local-auth.ts`) is a CLI-facing dev seam, not an HTTP auth provider —
  this is a deliberately separate, new implementation, not a reuse of that class. Real hosted
  OAuth/SSO sessions remain explicitly deferred future/hosted-profile work (docs/07 §4); this
  phase only wires the existing `ActorIdentity`/role model into a network-facing surface.
- **The webhook route is the one exception to the auth hook** — `/webhooks/*` and
  `/healthz`/`/readyz` are excluded inside the hook itself (a URL-prefix check), since GitHub
  authenticates via HMAC signature (`registerGithubWebhookRoute()`'s own verification), not a
  bearer token. Do not add per-route auth bypass logic elsewhere; the hook's exemption list is the
  single place this is decided.
- **`Idempotency-Key` is a required, client-supplied header used verbatim as
  `CommandEnvelope.idempotencyKey`** — deliberately not a server-synthesized
  `{commandName}:{resourceId}:{expectedVersion}` template the way CLI/task callers already build
  their own keys. This is a considered API-contract decision (not an oversight that happens to
  diverge from the established CLI convention): a client-supplied key gives real replay-safety
  across network retries/double-clicks, which a server-derived key cannot, and matches docs/01
  §9's literal wording ("`Idempotency-Key` header mapped to the `idempotency_keys` table"). A
  mutating request without this header is rejected with `400`/`missing-idempotency-key` before any
  handler runs — `TransactionalCommandExecutor` has no fallback for a missing key.
- **Command routing is a three-way split, not one generic dispatcher for everything.** (1)
  `POST /commands/:commandSlug` — generic dispatch over a `CommandRegistry` populated once at boot
  (`commands/registry.ts`, the registry's first production consumer anywhere in this codebase).
  Only handlers with a no-argument constructor are registered: every `human`-actorKind handler
  except `MergeIfReadyHandler`, plus a narrow `system`-actorKind allow-list
  (`GenerateImplementationPlanHandler`, `GenerateFeatureBacklogHandler`, `ValidateBacklogHandler`)
  reachable only via a `system`-kind API key, for manual replay of a stuck system-owned transition.
  `AssessPlanningReadinessHandler` is deliberately excluded from this allow-list — unlike its
  siblings, its constructor requires a live `PlannerAgentAdapter` instance, and no reference planner
  adapter has shipped yet (docs/02 §7). (2) `POST /commands/merge-if-ready` — a dedicated route,
  since it chains `MergeIfReadyHandler` → a real `GitHubClient.mergePullRequest()` call →
  `RecordMergedHandler`/`RecordMergeFailedHandler`+follow-up, exactly mirroring
  `packages/cli/src/commands/merge.ts`'s existing sequence; this cannot be a single generic
  dispatch. (3) `POST /commands/{request-coder-run,request-review,request-fixes,recompute-merge-gate}`
  — "enqueue" routes returning `{triggerdevRunId, accepted}` (a deliberate deviation from the
  standard `CommandResult` envelope, since these correspond to whole Trigger.dev task
  orchestrations, not a single synchronous command). `request-fixes` (docs/01 §9) has no standalone
  handler or task of its own — `StartFixingCommand` lives inside `run-review.ts`'s own
  `changes_requested -> fixing` decision chain — so it is served by re-triggering `request-review`,
  not a new task.
- **No default Trigger.dev SDK client is constructed for the enqueue routes.** `TaskTriggerClient`
  must be injected at server startup (`app.ts`'s `BuildAppOptions.taskTriggerClient`); the
  unconfigured default (`unconfiguredTaskTriggerClient()`) throws a fail-fast, actionable error
  only when one of these routes is actually invoked. This mirrors the established "no default
  PlannerAgentAdapter/ArbiterAgentAdapter, inject only" posture for capabilities with no shipped
  reference wiring at this layer — it was a deliberate choice to avoid importing
  `packages/triggerdev/src/triggerdev-tasks.ts` (which calls `task()` for all 18 canonical tasks at
  module load, a real Trigger.dev-runtime side effect) directly into the API process.
- **`generate final design document` / `approve final design document` (docs/01 §9) are not
  built.** No core command handler exists for either yet — the Design Document Generator is Phase
  17 scope. Building a route with no command behind it would violate this phase's own "API
  commands call core commands; no arbitrary state-mutation endpoints" acceptance criterion — these
  two endpoints are deferred wholesale to Phase 17, not stubbed as `501`.
- **The Trigger.dev _management_-API client (`minicoder trigger deploy/list-runs/inspect-run/
cancel-run/replay-run/drain-queue/reset-dev/reconcile`) is explicitly out of scope for this
  phase**, despite `packages/cli/src/commands/trigger.ts`'s stub comments saying "wired in Phase
  13." That refers to a different, external system (Trigger.dev's own control-plane API,
  authenticated via `TRIGGERDEV_API_URL`/`TRIGGERDEV_API_KEY`) — not the Orchestrator API this
  phase builds. Only the Orchestrator API's own `state`/diagnostics endpoints
  (`validate`/`doctor`/`reconcile`/`export-diagnostics`) are in scope; those CLI `trigger`
  subcommands remain stubbed until a future phase builds a real Trigger.dev management client.
- **`state repair --apply` stays CLI-only — it is not exposed via the API.** Its
  confirmation-token flow is a local file (`~/.minicoder/pending-repair-token.json`), which does
  not translate to a stateless HTTP API; only `validate`/`doctor`/`reconcile`/`export-diagnostics`
  (docs/01 §9's own diagnostics-action list, which excludes "repair") get command endpoints,
  wrapping shared query functions extracted into `packages/api/src/read-models/diagnostics.ts`
  and re-imported by `packages/cli/src/commands/state.ts` — the CLI and the API now share one
  implementation of this SQL instead of two independently-maintained copies.
- **Read-model query functions live in `packages/api/src/read-models/`, not `packages/core`.**
  `packages/core`'s architectural fitness tests are about keeping domain/state-transition logic out
  of task wrappers; read-only query helpers shaped around HTTP concerns (cursor pagination, DTO
  row shapes) don't belong in a "provider-SDK-free domain core" and would blur that boundary.
  `packages/cli/src/commands/state.ts` imports these functions from `@minicoder/api` rather than
  duplicating them — the CLI depending on the API package (not the reverse) is intentional, since
  the API is the newer, dependent surface.
- **`ApprovePlanHandler`/`ApprovePlanCommand`** (`packages/core/src/commands/handlers/plan/
approve-plan.ts`) was built in Phase 6 but never exported from `packages/core/src/index.ts` nor
  called anywhere — a real gap, closed here by exporting it and giving it a command endpoint
  (`approve-plan`) via the generic dispatch route.
- **OpenAPI contract**: hand-authored `packages/api/openapi/openapi.yaml` (not code-generated), a
  deliberate choice to avoid ESM-only/heavy codegen tooling fighting this repo's CommonJS build
  target. Validated at runtime by `ajv`/`js-yaml` (both CJS-safe). An `onRoute` Fastify hook
  (`openapi/register-openapi-hooks.ts`) throws **at route-registration time** — not just in a
  separate test — if a registered route has no matching operation in the spec, so spec drift fails
  the build immediately. Per-command request-body schemas are intentionally left as a generic
  `CommandPayload: type: object` rather than hand-transcribing 20+ Zod schemas into JSON Schema —
  real payload validation is enforced by each dispatched handler's own Zod schema (already tested
  since the phase that introduced it); this layer's runtime validation focuses on route/method/
  parameter-shape conformance (e.g. `limit` must be an integer in `[1, 100]`).
- **Problem-details error mapping (`errors.ts`) checks `CommandError` before any of its
  subclasses.** `MergeGateBlockedError extends CommandError` and already carries a fully-formed
  `merge-gate-blocked` `ProblemDetail` — there is deliberately no separate `instanceof
MergeGateBlockedError` branch (checking it after `CommandError` would never be reached; checking
  it before would just duplicate what `CommandError`'s own branch already does correctly).
- **`packages/github/src/webhook-app.ts`'s `addRawBodyCapture()` was changed from a private
  helper to an exported function** so the Orchestrator API can install the same raw-body-capturing
  content-type parser on its own shared Fastify instance before mounting
  `registerGithubWebhookRoute()` — GitHub's HMAC signature must be verified against the exact raw
  request bytes. `routes/webhooks.ts` calls both `addRawBodyCapture()` and
  `registerGithubWebhookRoute()` directly; it does not use `createWebhookApp()`, which builds a
  _standalone_ app for `minicoder github serve` and is unrelated to this composition.
- **`minicoder api serve`** (`packages/cli/src/commands/api.ts`) mirrors `minicoder github
serve`'s shape exactly (`--port`/`--host` options, does not close the DB connection, stays alive
  until terminated) — the CLI is a thin wrapper around `packages/api/src/server.ts`'s `serve()`.

**Post-implementation review fixes (round 1):**

- **HIGH-1 (`merge-if-ready`'s internal follow-up commands used the caller's own role, not
  admin).** `RecordMergedCommand`/`RecordMergeFailedCommand`/`ReconcileMergeFailedCommand` all
  require `UserRole.ADMIN` + `actorKind: 'system'` per their own matrix rows — the same identity
  every Trigger.dev task and `packages/cli/src/commands/merge.ts` already build via
  `systemActor()`. The route instead built `{..., role: actor.role, actorKind: 'system'}`, copying
  the approver's own role (rank 2) into a "system" actor — since `admin` is rank 3, every real
  approver-initiated merge would pass `MergeIfReadyHandler` (approver-gated), succeed against
  GitHub, and then fail `RecordMergedHandler`/`RecordMergeFailedHandler` with a 403
  `authorization-error`, having already merged the PR with no local record of it. Fixed by using
  `systemActor(correlationId)` from `@minicoder/triggerdev` for these three dispatches, matching
  the CLI reference implementation exactly. A new happy-path test in
  `merge-if-ready-route.test.ts` exercises the full approver flow end-to-end and would have caught
  this (the existing tests only covered blocked-gate and not-found paths, never a passing gate).
- **HIGH-2 (task-trigger and diagnostics routes authenticated but never authorized).**
  `task-trigger-routes.ts` (`request-coder-run`/`request-review`/`request-fixes`/
  `recompute-merge-gate`) and `diagnostics-routes.ts` (`validate`/`doctor`/`reconcile`/
  `export-diagnostics`) don't dispatch through `TransactionalCommandExecutor`, so neither got
  `assertRole` for free — unlike every command reachable via the generic dispatch route or the
  dedicated `merge-if-ready` route (both of which enforce a role floor through the handler they
  call). A `viewer`-role API key could otherwise trigger real coder/reviewer/merge-gate work, or
  call `reconcile` (which mutates `workflow_locks` and can mark `outbox_events`/`inbox_events` rows
  `failed` globally). Fixed with a shared `requireRole()` helper (`auth/require-role.ts`, wrapping
  `assertRole()`), called first thing in every one of these eight route handlers with an
  `operator` floor (docs/00 §4.4 names `request coder/review run`, `recompute merge gate`, and
  `reconcile` as operator-level capabilities; `validate`/`doctor`/`export-diagnostics` are held to
  the same floor for consistency, since `export-diagnostics` can surface workflow-event payload
  contents a viewer shouldn't pull). Regression tests assert a `viewer` key gets `403`
  `authorization-error` on all eight routes and that the injected `TaskTriggerClient`/mutating
  read-models are never actually invoked.
- **HIGH-3 (`merge-if-ready` had no whole-route idempotent replay).** The route splits the
  client-supplied `Idempotency-Key` into per-command suffixed keys (`:merge-ready`,
  `:record-merged`, etc.), which does make each individual command dispatch replay-safe — but nothing
  cached the overall HTTP response. Retrying the same `Idempotency-Key` after a completed request
  would replay `:merge-ready` (a no-op, already merge_ready or already past it), then hit the
  `current_execution_state !== MERGE_READY` guard and fail with a `400`, even though the original
  request had already succeeded (or definitively failed) — a client-side retry after a network
  timeout could see a spurious failure for a merge that actually went through. Fixed by caching
  the full `{status, body}` response against the client's `Idempotency-Key` in `idempotency_keys`
  under a distinct `merge-if-ready-route` scope (so it can't collide with the per-command
  sub-keys), checked before any work begins and written on every terminal exit path from
  `githubClientFactory()` onward. A regression test performs the same request twice with the same
  header and asserts byte-identical responses without a second GitHub call.
- **MEDIUM-1 (fallback 500 responses echoed the raw exception message).** `toProblemDetails()`'s
  generic branch interpolated `err.message` directly into the client-facing `detail` field —
  an unrecognized DB driver error, provider/SDK error, or anything else routed here could leak
  connection strings, credentials, or other internals to the caller. Fixed to always return a
  stable, generic detail string for unrecognized errors; the real message is still logged
  server-side via `console.error` for operator debugging. `errors.test.ts` and
  `task-trigger-routes.test.ts` both assert the client-visible body never contains the original
  message.

**Post-implementation review fixes (round 2 — re-review):**

- **HIGH-1 (`merge-if-ready`'s round-1 idempotency fix was post-hoc, not concurrency-safe).**
  Round 1's fix checked for a cached response, did all the work (including the real GitHub merge
  call), and only stored the response at the end — two concurrent requests carrying the same
  `Idempotency-Key` could both miss the cache and both reach `githubClient.mergePullRequest()`
  before either response was written, reopening the exact duplicate-side-effect race idempotency
  exists to close. Fixed with a real claim-first pattern
  (`route-idempotency.ts`'s `claimRouteIdempotencyKey()`/`fulfillRouteIdempotencyKey()`/
  `releaseRouteIdempotencyKey()`), mirroring `packages/core/src/commands/helpers.ts`'s existing
  `claimIdempotencyKey`/`fulfillIdempotencyKey` command-level pattern but reusable at the route
  layer for routes that span a real external side effect: the `(key, scope)` row is reserved via
  `INSERT ... ON CONFLICT DO NOTHING` _before_ any GitHub call or command dispatch, so the UNIQUE
  constraint — not application logic — serializes concurrent claims. A second concurrent request
  with the same key sees `in-progress` and gets a retryable `409` (`request-in-progress`), never
  re-running the side effect. If the claiming request throws before producing a response (a
  pre-check failure, an infra error), the claim is released rather than left to block every retry
  until the 7-day TTL expires. Two new regression tests: a simulated in-flight claim asserts `409`
  or a same-key retry, and a forced pre-check failure (missing PR/repo) asserts the claim is
  released so an identical retry deterministically re-fails the same way instead of getting stuck
  at `in-progress`.
- **HIGH-2 (`reconcile` remained a mutating route with no idempotency of its own).** Round 1 added
  role authorization to all four diagnostics routes but only `reconcile` has a real side effect
  (clearing stale `workflow_locks`, marking `outbox_events`/`inbox_events` `failed`) — `validate`/
  `doctor`/`export-diagnostics` are pure reads and need none. Fixed by requiring an
  `Idempotency-Key` header on `reconcile` specifically and wrapping its mutation in the same
  claim-first `route-idempotency.ts` helpers (a distinct `reconcile-route` scope, 24h TTL — shorter
  than `merge-if-ready-route`'s 7 days, since a stale reconcile decision is cheap to safely re-run
  once the TTL lapses, unlike a merge outcome). Regression tests cover the missing-header `400`,
  a repeated-key replay, and a simulated in-flight `409`.

**Post-implementation review fixes (round 3 — re-review):**

- **HIGH (route idempotency replay was not Postgres-safe).** `idempotency_keys.result` is `JSONB`
  in PostgreSQL but `TEXT` in SQLite; the `pg` driver auto-parses JSON/JSONB columns into JS
  objects, so a fulfilled row's `result` comes back as an already-parsed object on Postgres, not a
  string. `route-idempotency.ts`'s `claimRouteIdempotencyKey()` unconditionally called
  `JSON.parse(row.result)`, which throws when `row.result` is already an object — every replayed
  `merge-if-ready`/`reconcile` request would 500 on a real Postgres deployment despite passing
  every SQLite-backed test. Fixed by reusing `packages/core/src/commands/helpers.ts`'s existing
  `parseJsonField()` (accepts `unknown`, parses only strings, passes objects through unchanged) —
  the exact pattern `TransactionalCommandExecutor`'s own idempotency-cache read already uses for
  this identical cross-dialect shape difference. A new unit test
  (`route-idempotency.test.ts`) mocks `DbClient.query` to return both a SQLite-shaped string
  result and a Postgres-shaped already-parsed-object result, asserting the same correct output for
  both without throwing.
- **HIGH (`merge-if-ready`'s release-on-error was unsafe once GitHub had already merged).** Round 2
  made the route release its claim on any thrown error so a corrected retry isn't stuck — but that
  is only safe _before_ `githubClient.mergePullRequest()` succeeds. If the GitHub merge succeeds
  and `RecordMergedHandler` (or anything after it) then throws, releasing the claim would let a
  same-key retry re-enter the handler, replay the already-idempotency-cached `:merge-ready`
  sub-dispatch as a no-op, find the run still sitting at `merge_ready`, and call
  `mergePullRequest()` a **second** time against an already-merged PR — misrecording a real
  success as a failure/escalation, not merely a wasted retry. Fixed with a `mergeSucceeded` flag
  set only immediately after a successful `mergePullRequest()` call; the outer catch now checks it
  before deciding whether to release the claim. Once true, the claim is deliberately left in its
  unfulfilled `in-progress` state (logged via `console.error` for operator visibility) rather than
  released — a retry then gets `409 request-in-progress` instead of a silent double-merge attempt,
  and an operator must inspect/resolve the discrepancy directly. Building a fully automatic
  recovery path (e.g. detecting the PR is already merged and completing the recording on retry) is
  future work; leaving the claim in place is the safe interim posture, not a placeholder pretending
  to be a full fix. A new regression test forces exactly this window (a fake `GitHubClient` whose
  `mergePullRequest()` succeeds but also mutates `feature_runs.version` first, so
  `RecordMergedHandler`'s own optimistic-lock check fails immediately afterward) and asserts a
  same-key retry gets `409`, not a second merge attempt.
- **MEDIUM (the OpenAPI contract didn't reflect `reconcile`'s new idempotency requirement).**
  `POST /commands/reconcile`'s operation had no `Idempotency-Key` parameter and no documented `409`
  response even though round 2 made the header required at runtime — `openapi/openapi.yaml` now
  declares both, matching `merge-if-ready`'s existing parameter/response shape (whose `409`
  description was also broadened to mention the in-progress case introduced in round 2).

**Post-implementation review fixes (round 4 — issue #56):**

- **The "building a fully automatic recovery path is future work" note above is now closed.**
  Round 3 deliberately left a feature run stuck at `merge_ready` (GitHub merged, recording failed)
  requiring manual operator investigation with no tool-assisted recovery. Fixed with a new,
  explicit recovery command rather than automatic/silent recording (the safer of the two options
  the issue proposed): `minicoder merge finalize-if-github-merged --feature-run <id> --project
<id>` (`packages/cli/src/commands/merge.ts`) and its API twin, `POST
/commands/finalize-if-github-merged` (`packages/api/src/commands/finalize-if-github-merged-route.ts`,
  operator-role-gated via `requireRole()`). Both: no-op with `{alreadyRecorded: true}` if the run is
  already `merged`; reject if the run is at any state other than `merge_ready`/`merged`; **always
  re-verify against GitHub** via `GitHubClient.getPullRequest()` before recording anything — refuse
  with a clear error if GitHub does not report `state: 'merged'` with a `mergedAt` timestamp, so
  this path can never be tricked into recording a merge that didn't happen; then dispatch
  `RecordMergedCommand` (via `systemActor()`, matching every other internal follow-up write in this
  file) using `observed.mergeSha ?? observed.headSha`. Deliberately does **not** attempt to locate
  or clear the original stuck `merge-if-ready-route` idempotency-key row — that row has no column
  linking it back to a `featureRunId` (only the caller's opaque `Idempotency-Key` header), so
  guessing which row to clear would be unsafe; it self-clears via its existing 7-day TTL, and a
  retry against it after this recovery command runs would simply fail `MergeIfReadyHandler`'s own
  "still at `merge_ready`" guard harmlessly (the run has already moved to `merged` by then) rather
  than causing any real problem. Regression tests cover: already-merged no-op, wrong-state
  rejection, GitHub-not-confirmed rejection (feature run stays untouched), and the full recovery
  path recording the merge.

## Cross-Dialect Testing (Mandatory)

The integration test suite and migration validation **must** run against both SQLite and PostgreSQL
as a matrix. This is a CI requirement, not optional. The security scan
(pnpm audit/OSV + gitleaks + semgrep) also runs in CI.

CI enforces `pnpm audit --prod --audit-level=high` (runtime dependencies only). Two dev-only
advisories are known and accepted: GHSA-5xrq-8626-4rwp (vitest critical — UI server not used) and
GHSA-fx2h-pf6j-xcff (vite high — Windows-only path, CI runs Linux). Full rationale in
docs/04 §12.13. Full `pnpm audit --audit-level=high` will report these locally — that is expected.

**Concurrency scenario tier (issue #43, docs/04 §12.15):**
`packages/testing/src/execution-orchestrator-concurrency.postgres.test.ts` is a genuinely
concurrent (`Promise.all`-driven), PostgreSQL-only integration scenario racing
`start-next-feature`, `github-reconciliation`, and an operator pause against the same project.
It is PostgreSQL-only by design, not convenience: `better-sqlite3` is a synchronous single-thread
binding, so two `SqliteDbClient` connections to the same file cannot genuinely race — an
overlapping write from a second connection either never truly overlaps or deadlocks against
`busy_timeout` (confirmed empirically: a same-file multi-connection SQLite version of this exact
scenario reliably deadlocked every iteration). PostgreSQL's client-server architecture has no such
limitation. Gated by `MINICODER_TEST_PG_URL`, same posture as the other Postgres-only suites.
Issue #41 adds a sibling suite in this same tier,
`packages/testing/src/phase8-concurrency-guards.postgres.test.ts`, proving the specific Phase 8
guards above (`SelectFeatureHandler`'s CAS, `StartCodingHandler`'s automation-state re-check,
`idempotency_keys`' claim-first `ON CONFLICT DO NOTHING`, `WorkflowLockManager`'s fence-token CAS)
against real concurrent PostgreSQL connections rather than sequential re-dispatch. Issue #57 adds
a third suite, `packages/api/src/route-idempotency.postgres.test.ts`, proving the route-level
claim → fulfill → reclaim round-trip through a real `result JSONB` column and a genuine
concurrent-claim race resolving to exactly one `owned` outcome.

## Vitest Test Command Tiers

| CLI command                  | What it runs                                                                     | Config                                      |
| ---------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- |
| `minicoder test unit`        | All `*.test.ts` except `*.integration.test.ts` (includes scenario/fixture tests) | `vitest.unit.config.ts`                     |
| `minicoder test integration` | Only `*.integration.test.ts` (requires real DB)                                  | root `vitest.config.ts` + positional filter |
| `minicoder test system`      | Programmatic scenario runner (`runAllScenarios()`)                               | —                                           |
| `pnpm test`                  | All `*.test.ts` including integration                                            | root `vitest.config.ts`                     |

`vitest.unit.config.ts` excludes `**/*.integration.test.ts` and is the only way to run the
non-integration Vitest tier via CLI. Do not add `--include`/`--exclude` CLI flags — Vitest 1.6.x
does not support them; use a separate config file instead.

## SQLite Test Teardown Rule

**Never call `db.close()` in tests** (including `afterEach`/`afterAll` hooks).

`better-sqlite3` registers native GC finalizers for `Database` and `Statement` objects.
Explicit `db.close()` calls `sqlite3_close()`, which finalizes all statements on the database.
When V8's GC later runs the `Statement` finalizer, it double-frees → SIGSEGV (exit 139). Let
GC handle teardown order naturally — do not add explicit close calls.

`vitest.config.ts` uses `pool: 'forks'`: each test file runs in a forked child process that
calls `process.exit()` on completion, bypassing V8 GC finalizers entirely. Do not change
`pool` without understanding this constraint.

## Typecheck Script Ordering

The root `pnpm typecheck` script builds packages sequentially (generating `dist/`) before
running `--noEmit` on dependents. Any package whose `types` field points to `dist/` must
appear in the ordered build chain in `package.json` before the recursive `pnpm -r` pass.
Current order: `core → persistence-sqlite → persistence-postgres → workflow → github → adapters-coder → triggerdev → testing → (rest --noEmit)`.
`workflow` moved ahead of `github`/`triggerdev` in Phase 7: `packages/github`'s inbox handlers and
`packages/triggerdev`'s `github-reconciliation` task both acquire a `WorkflowLockManager` lock
before dispatching a lock-gated reconciliation command (`RecordPrOpenedCommand`/
`RecordCiRunningCommand`), so both now depend on `@minicoder/workflow` for its type. `github` was
also added ahead of `triggerdev` (`github-reconciliation.ts` imports `OctokitGitHubClient` from
`@minicoder/github`). `adapters-coder` was added ahead of `triggerdev` in Phase 9:
`packages/triggerdev/src/tasks/run-coder.ts`'s default resolver dynamically imports
`CodexCoderAdapter`/`HttpCodeGenerationProvider`/`CoderSandbox` from `@minicoder/adapters-coder`
(the same "constructs the real reference implementation from env, dynamic `import()`" pattern
`github-reconciliation.ts` already uses for `OctokitGitHubClient`), so `packages/triggerdev`
depends on `@minicoder/adapters-coder`'s type declarations.

When adding a new workspace package that others import for types, add it to this chain.

## Budget Gate

The budget-gate primitive ships in **Phase 8** (not Phase 16). Phase 16 adds dashboards and
forecasting only.

Key tables: `budget_policies` (thresholds/config, scope ∈ {project, feature, review_cycle}),
`cost_records` (spend rows), `policy_decisions` (human override audit trail). Key transitions:

- Hard limit breach → `paused_budget_exceeded`
- Soft limit breach → `waiting_for_budget_approval`

The review/fix loop is also a budget scope; breaching the per-feature threshold trips the circuit
breaker and escalates to human.

**Implementation (`packages/core/src/cost/`):** `evaluateBudget(db, { projectId,
featureRequestId?, scope })` reads the active `budget_policies` row for the scope and computes
`SUM(cost_records.amount)` **live** (no denormalized running-total column — Phase 8 data volumes
don't justify a second source of truth to keep in sync with `cost_records`; a materialized rollup
can be added in Phase 16 without changing this function's contract). Hard limit is checked
**before** soft limit, so a policy breaching both reports `hard_breach`. `applyBudgetDecision(db,
evaluation, {...})` is the orchestration glue that turns a breach verdict into a state transition —
it dispatches `RecordBudgetExceededCommand` (hard) or `RecordBudgetApprovalWaitingCommand` (soft)
via `TransactionalCommandExecutor`, and no-ops on `ok`. It is deliberately separate from the
`RecordBudget*Handler`s themselves, which stay pure state-transition logic and write no
`cost_records`/`policy_decisions` row of their own — the row must already exist before evaluation
runs, and only the human override (`ApproveBudgetOverrideHandler`) records a `policy_decisions`
row, not the system-triggered breach.

## Security Sandbox Rules (docs/07, §6)

- Workspaces are ephemeral and isolated per agent run.
- Default-deny egress: only the assigned LLM provider and GitHub are allow-listed.
- Dependency provisioning under default-deny: pre-baked base image, read-only bind-mounted
  pre-indexed pnpm store, or internal package proxy/mirror. The public npm registry is never
  directly reachable from the sandbox in hosted/team. Local dev may use a clearly-labelled
  allow-list (forbidden in hosted/team).
- Bounded diffs: max diff size enforced; no merge commits from the sandbox.

## State Repair CLI

`state repair` requires `--project <id>` and two steps:

1. `minicoder state repair --project <id> --dry-run` — previews changes, prints a single-use
   confirmation token (expires in 5 minutes).
2. `minicoder state repair --project <id> --apply --confirmation <token>` — executes; token is
   time-boxed, single-use, and bound to the project ID that issued it.

`state purge` does not exist. Irreversible maintenance uses only the guarded `repair --apply` path.
Global (unscoped) repair is not supported — `--project` is mandatory for both steps.

## Database Reset CLI (`minicoder db reset` / `packages/migrations/src/runner.ts`)

`db reset`'s safety contract was strengthened (issues #10/#11) from warn-only to fully enforced,
mirroring `state repair`'s two-step dry-run/apply/confirmation-token shape:

1. `minicoder db reset --dry-run --env <env> --actor <name> (--backup-verified | --backup-exempt "<reason>")`
   — previews (no mutation) and prints a single-use confirmation token (expires in 5 minutes),
   bound to the exact database target (host+port+path for PostgreSQL, resolved file path for
   SQLite) — a token issued while previewing one target cannot be replayed against another.
2. `minicoder db reset --apply --yes --confirmation <token> --env <env> --actor <name> (--backup-verified | --backup-exempt "<reason>")`
   — executes.

Additional enforced checks (all before any mutation, all before a SQLite file is created or a
PostgreSQL connection is used):

- **`--env`/system-env agreement**: when `APP_ENV`/`NODE_ENV` is set, `--env` must match it
  exactly — not just both be in the safe set.
- **Unset system env is never inferred as safe**: requires the explicit `--disposable-db` flag.
- **`--actor <name>` is required** and recorded in the audit log — Phase 1's CLI has no
  session/role system, so this is a caller-declared identity, not an authenticated principal (the
  strongest this profile can offer; real auth is docs/07 scope).
- **Backup evidence is required**: `--backup-verified` or `--backup-exempt "<reason>"`, recorded in
  the audit log (never a bare warning).
- **PostgreSQL host allowlist**: the target host must be in `MINICODER_ALLOWED_RESET_HOSTS`
  (comma-separated; defaults to `localhost`/`127.0.0.1`/`::1`) or the caller must pass the explicit,
  visible `--force-host` override.
- **Credential/query-string redaction**: `sanitizeDbIdentifier()` reduces a PostgreSQL URL to
  `protocol://hostname:port/pathname` before ever logging it — username, password, query string,
  and fragment are all dropped, not just the URL authority. A malformed URL is replaced with a
  fixed, non-sensitive placeholder rather than echoing the raw input.

## State Reconcile CLI

`state reconcile` requires either `--project <id>` or `--all`:

- `--project <id>` only: clears stale workflow locks scoped to that project; does **not** touch
  global queues.
- `--all`: clears stale locks globally **and** marks stuck `outbox_events`/`inbox_events` as
  failed. Global queue mutation requires explicit `--all`.
- Neither flag: exits 1.

`outbox_events` and `inbox_events` have no `project_id` column and are always global scope.
`state doctor` and `state export-diagnostics` label these entries with `scope: 'global'`.
`state export-diagnostics` groups all global tables under `globalOperationalState: { scope: 'global', ... }`.

## Dev/Test-Only Command Safety Guards

The following commands write directly to application tables and are restricted to development, test,
and CI environments:

- `minicoder db seed` — inserts fixture data
- `minicoder db restore` — overwrites the live database file
- `minicoder github simulate-*` — inserts inbox events

All three commands call `guardEnv()` which enforces two levels:

1. **Hard production reject (cannot be overridden):** exits 1 immediately if `APP_ENV` or
   `NODE_ENV` is `'production'` — regardless of any `--env` flag passed by the caller.
2. **Allowed-env check:** target env (from `--env`, then `APP_ENV`, then `NODE_ENV`) must be one
   of `development`, `test`, or `ci`.

`--env development` cannot be used to bypass a production process environment.

## What Multiple State Machines Look Like

There are several distinct state machines — not one:

- **Project**: `active → implementation_complete → ... → project_complete`
- **Plan**: `draft → pending_approval → approved → activated_for_execution`
- **Feature (execution)**: §3.2 above
- **PR/review**: mirrors GitHub (`none | pending | commented | changes_requested | approved | dismissed`)
- **Agent run**: `queued | running | succeeded | failed | cancelled`
- **Workflow run**: `queued | running | waiting | succeeded | failed | cancelled`
- **Clarification session**: §3.6 above
- **Artifact export**: `pending | generating | exported | stale | failed`
- **Budget gate**: §3.8 above

## Technology Stack (Locked)

| Concern              | Choice                              |
| -------------------- | ----------------------------------- |
| Language             | TypeScript                          |
| Runtime              | Node.js                             |
| Package manager      | pnpm                                |
| Local/single-node DB | SQLite                              |
| Hosted/team DB       | PostgreSQL                          |
| Validation           | Zod                                 |
| Testing              | Vitest                              |
| GitHub API           | Octokit                             |
| Workflow execution   | Trigger.dev                         |
| API framework        | Fastify                             |
| Text UI              | Ink                                 |
| Web UI               | React / Next.js                     |
| Security scanning    | pnpm audit/OSV + gitleaks + semgrep |

**Local setup prerequisite:** the root `package.json`'s `build`/`typecheck`/`lint`/`test` scripts
shell out to nested `pnpm -r ...`/`pnpm --filter ...` calls, so `pnpm` must be resolvable on
`PATH` before running any of them — via `corepack enable` (one-time) or a global `pnpm` install.
This is a documentation note, not a script change: swapping the scripts themselves to invoke
`corepack pnpm` risks behaving differently under `pnpm/action-setup`-based CI, which is out of
scope to verify here.

## Editing Guidelines for Documentation

- Every `docs/` file must keep its `Status: Canonical`, `Supersedes:`, `Version:`, and
  `Last-updated:` header.
- State names, role names, adapter names, and CLI commands used in any doc must match
  `00-glossary-and-terms.md` exactly.
- Do not introduce a new term, state, or adapter name without adding it to `00-glossary-and-terms.md`
  first.
- After editing docs, run grep sweeps to verify no stale/removed tokens remain (e.g., search for
  old status-check names, removed CLI commands, or superseded role names).
- `docs/06-implementation-plan.md` is the **single canonical 18-phase plan**. Do not add a
  parallel or competing phase list elsewhere.

## Discovery Backlog

The "discovery backlog" concept maps to `feature_requests` rows with `kind=discovery,
executable=false`. Backlog activation excludes `kind=discovery` rows. They are never directly
executable.

## Clarification Circuit Breaker

Clarification has a per-round timeout and a maximum of 3 rounds. Exceeding these limits produces
`clarification_blocked` followed by `human_required`.
