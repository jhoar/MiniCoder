# MiniCoder — Claude Code Project Guide

## What This Repository Is

MiniCoder is an **Agentic Software Development Orchestration System** that converts user intent or
system specifications into a clarified, approved, sequential implementation backlog, then
orchestrates feature-branch development, pull requests, structured reviews, fixes, merge gates,
and final design documentation.

This repository contains the **Phase 1–3 and 5–8 implementation**: monorepo skeleton, persistence
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
`ApproveBudgetOverrideCommand`) (Phase 8, no new migration).
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

All 15 canonical task IDs (`ALL_TASK_IDS` in `packages/triggerdev/src/task-ids.ts`). The 9 Phase 3
tasks and the 6 Phase 6 additions are listed together — there is no "initial vs. later" distinction
in the token set itself, only in when each task's `runImpl` was wired to a real core command:

```
ingest-specification | planning-readiness-assessment | start-clarification
record-clarification-answer | complete-clarification | generate-implementation-plan
generate-feature-backlog | validate-backlog | request-plan-approval
activate-approved-backlog | start-next-feature | github-reconciliation
export-plan | export-backlog | import-backlog
```

Every canonical task, including `github-reconciliation` (Phase 7) and `start-next-feature`
(Phase 8), now calls a real Orchestrator Core command through `TransactionalCommandExecutor`.

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
  `ORDER BY run_at DESC LIMIT 1` scoped to `(test_suite, adapter_id)` for "the current result".
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
- **`github-reconciliation`'s scheduled fallback only re-checks feature runs that already have a
  `pull_requests` row.** Discovering a brand-new PR that no webhook has ever reported requires a
  `GitHubClient.listPullRequestsForBranch`-style method that does not exist yet — do not assume
  the scheduled task will self-heal a completely missed `pr.opened` webhook.
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
- **Budget breach and override idempotency keys must include `{expectedVersion}` (or another
  per-occurrence discriminator), never `{projectId}` alone.** A project can legitimately breach
  the same threshold, get overridden, and breach again over its lifetime; each occurrence is read
  against a distinct `workflow_states.version`. A key scoped to `projectId` alone lets
  `TransactionalCommandExecutor` return the _first_ occurrence's cached `CommandResult` for every
  later one within the 7-day idempotency TTL, silently no-opping the transition (this was a real
  bug — HIGH-1 in the Phase 8 code review — fixed in `apply-budget-decision.ts`'s
  `RecordBudgetExceededCommand`/`RecordBudgetApprovalWaitingCommand` dispatch and documented as a
  caller obligation for `ApproveBudgetOverrideCommand`). The `execution-orchestrator` scenario's
  step 4b exercises a repeated soft breach specifically to guard against a regression here.
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

## Cross-Dialect Testing (Mandatory)

The integration test suite and migration validation **must** run against both SQLite and PostgreSQL
as a matrix. This is a CI requirement, not optional. The security scan
(pnpm audit/OSV + gitleaks + semgrep) also runs in CI.

CI enforces `pnpm audit --prod --audit-level=high` (runtime dependencies only). Two dev-only
advisories are known and accepted: GHSA-5xrq-8626-4rwp (vitest critical — UI server not used) and
GHSA-fx2h-pf6j-xcff (vite high — Windows-only path, CI runs Linux). Full rationale in
docs/04 §12.13. Full `pnpm audit --audit-level=high` will report these locally — that is expected.

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
Current order: `core → persistence-sqlite → persistence-postgres → workflow → github → triggerdev → testing → (rest --noEmit)`.
`workflow` moved ahead of `github`/`triggerdev` in Phase 7: `packages/github`'s inbox handlers and
`packages/triggerdev`'s `github-reconciliation` task both acquire a `WorkflowLockManager` lock
before dispatching a lock-gated reconciliation command (`RecordPrOpenedCommand`/
`RecordCiRunningCommand`), so both now depend on `@minicoder/workflow` for its type. `github` was
also added ahead of `triggerdev` (`github-reconciliation.ts` imports `OctokitGitHubClient` from
`@minicoder/github`).

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
