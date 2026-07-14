# MiniCoder Agent Guide

## Purpose

This repository implements **MiniCoder**, an agentic software-development orchestration system.
MiniCoder turns specifications into an approved, database-backed backlog and is designed to
orchestrate feature branches, pull requests, reviews, fixes, merge gates, and final design
documentation.

Use this file as the practical guide for modifying the repository. The canonical product and
architecture requirements remain under `docs/`.

## Current Repository State

- The canonical specification describes an 18-phase architecture.
- The codebase currently contains the **Phase 1–17 implementation**. Phase 18 remains future
  extension scope. Do not describe the repository as specification-only, and do not assume future
  extensions are implemented unless the current code/tests prove it.
- In summary, the implemented system includes:
  - TypeScript/pnpm monorepo with strict package boundaries.
  - Provider-neutral core domain, state machines, command executor, local auth, redaction,
    persistence abstractions, and SQLite/PostgreSQL adapters.
  - Paired migrations through `0017_task_queue` plus database lifecycle CLI commands.
  - Durable workflow primitives: outbox/inbox dispatch, locks, fencing tokens, execution lanes, and
    idempotent command handling.
  - Phase 4 testing harness, deterministic fixtures, mock adapters, conformance tests, scenario
    registry, and system-test CLI commands.
  - Workflow Layer task implementations for all 19 canonical task IDs. The current execution
    backend is an in-repo DB-backed task queue in `packages/triggerdev`, not the Trigger.dev
    product.
  - GitHub webhook receiver, provider-SDK-free `GitHubClient` seam in core, Octokit implementation
    outside core, PR mirror table, and shared reconciliation algorithm.
  - Reference planner, coder, reviewer, arbiter, and documentation adapter packages, with provider
    SDKs kept outside core.
  - Execution orchestration, review/fix loop, disagreement/arbiter/human-escalation flow, merge
    gate, branch-protection/status-check publishing, and final project/design-document lifecycle.
  - Fastify Orchestrator API, Ink Text UI commands, and Next.js Web UI routes.
  - Observability/cost/recovery read models and tools: feature-run timeline, budget forecasting and
    reporting, secret-leak doctor check, optional OTLP export, and export cursors.
  - Final Design Document Generator, `DocumentationAgentAdapter`, `run-design-doc`,
    `final-design-document.md` export, project acceptance validation, and design-doc approval flow.
- Trigger.dev references in historical phase narratives are historical only. Current operational
  guidance must say **Workflow Layer** for the subsystem and **DB-backed task queue** /
  `minicoder tasks worker` for the concrete runtime.
- Before starting work, inspect the current branch, recent commits, and working tree:

```bash
git status --short --branch
git log --oneline -10
```

Never hard-code a development branch name in instructions or scripts.

## Sources of Truth

Apply this precedence when requirements appear to conflict:

1. The current user/task requirements.
2. Canonical documents under `docs/`.
3. Tests and executable code for current implementation behavior.
4. `README.md` and `CLAUDE.md` as non-authoritative summaries.

Within `docs/`:

- `docs/00-glossary-and-terms.md` owns shared vocabulary, exact state tokens, roles, adapter names,
  identifiers, CLI names, deployment profiles, and the locked stack.
- `docs/01-system-specification.md` owns architecture, authority boundaries, consistency, API
  conventions, merge policy, and project acceptance validation.
- `docs/06-implementation-plan.md` is the only canonical phase plan.
- `docs/07-security-and-secrets.md` is authoritative for secrets, authentication, sandboxing,
  egress, payload hygiene, and untrusted content.

Read the documents in numeric order when a change crosses subsystem boundaries.

## Repository Map

```text
docs/                           Canonical product and architecture specifications
packages/core/                  Provider-neutral domain, config, persistence, and adapter contracts
packages/persistence-sqlite/    better-sqlite3 implementation of core persistence contracts
packages/persistence-postgres/  pg implementation of core persistence contracts
packages/migrations/            Paired SQLite/PostgreSQL migrations and lifecycle runner
packages/workflow/              Locks, execution lanes, outbox/inbox dispatch, and sweepers
packages/github/                GitHub webhook receiver, inbox handlers, and Octokit client
packages/triggerdev/            Workflow Layer tasks plus DB-backed task queue runtime
packages/adapters-coder/        Reference CodexCoderAdapter + sandboxed code generation
packages/adapters-reviewer/     Reference ClaudeReviewerAdapter + review seam
packages/adapters-planner/      Reference GenericLLMPlannerAdapter
packages/adapters-arbiter/      Reference ClaudeArbiterAdapter
packages/adapters-documentation/ Reference ClaudeDocumentationAdapter + final design-doc seam
packages/api/                   Fastify Orchestrator API: read models, command dispatch, OpenAPI
packages/tui/                   Ink Text UI: API client + render views, consumed by packages/cli
packages/web/                   Next.js Web UI: server-only API client and docs/05 routes
packages/testing/               Deterministic fixtures, mock adapters, conformance, scenarios, runner
packages/cli/                   Thin Commander-based CLI (DB-direct, API, TUI, and worker commands)
infra/docker-compose.coder-sandbox.yml  Ephemeral coder-sandbox support stack
infra/docker-compose.test.yml   Disposable PostgreSQL test stack
infra/k8s/                      Batch jobs for migrations, seed, diagnostics, reconciliation, system tests
.github/workflows/ci.yml        CI checks, database matrix, system smoke, and dependency audit
```

Important files:

- `packages/core/src/domain/states.ts` mirrors canonical tokens from the glossary.
- `packages/core/src/domain/entities.ts` defines persisted domain shapes.
- `packages/core/src/persistence/types.ts` defines database-neutral interfaces and concurrency
  errors.
- `packages/core/src/statemachine/machines/` contains the implemented transition matrices.
- `packages/core/src/commands/` contains the command registry, executor, and contracts.
- `packages/core/src/commands/handlers/planning/` and `.../clarification/` contain the Phase 6
  planning and clarification command handlers. `ValidateBacklogHandler` owns backlog quality
  evidence, and `SubmitPlanForApprovalHandler` must require current valid backlog evidence before
  `pending_approval`.
- `packages/core/src/commands/handlers/github/` contains GitHub-facing feature-execution
  handlers. These handlers update MiniCoder state from GitHub observations; GitHub remains
  authoritative for PR/review/CI facts.
- `packages/core/src/commands/handlers/feature/`, `.../automation/`, `.../merge/`, and
  `.../project/` contain execution orchestration, automation control, merge gate, and final
  project/design-document lifecycle handlers.
- `packages/core/src/github/` owns the provider-SDK-free GitHub client interface and shared
  reconciliation algorithm. Octokit belongs only in `packages/github/`.
- `packages/core/src/cost/` owns budget evaluation and forecasting.
- `packages/core/src/observability/` owns OTLP export and export-cursor helpers.
- `packages/core/src/design-doc/` owns final design-document evidence collection, section writing,
  and Markdown rendering.
- `packages/core/src/project/acceptance.ts` owns DB-knowable project acceptance validation.
- `packages/core/src/events/schemas.ts` owns versioned event payload validation.
- `packages/core/src/auth/` contains actor identity, local auth, authorization, and redaction.
- `packages/core/src/adapters/types.ts` defines provider-neutral role adapter interfaces and I/O
  contracts, including the documentation role.
- `packages/core/src/adapters/capabilities.ts` owns capability token schemas, validation, and
  canonical ordering.
- `packages/core/src/adapters/registry.ts` implements database-backed adapter registration,
  capability validation, configuration resolution, and source-of-truth lookup.
- `packages/core/src/adapters/run-recorder.ts` persists adapter run lifecycles, redacted summaries,
  normalized errors, provenance snapshots, and provider/model/cost/token metadata.
- `packages/workflow/src/locks/manager.ts` implements lease ownership and fencing.
- `packages/workflow/src/outbox/dispatcher.ts` and `inbox/processor.ts` implement durable dispatch.
- `packages/triggerdev/src/task-ids.ts` owns all 19 canonical task ID constants (`ALL_TASK_IDS`).
- `packages/triggerdev/src/task-registry.ts` registers the SDK-free `TASK_REGISTRY`.
- `packages/triggerdev/src/task-worker.ts` implements the DB-backed task queue dispatcher.
- `packages/triggerdev/src/tasks/` contains command-backed task implementations, including
  `run-coder`, `run-review`, `run-merge-gate`, and `run-design-doc`.
- `packages/triggerdev/src/db.ts` probes `triggerdev_runs`, `task_queue`, and
  `task_concurrency_gates` schema readiness.
- `packages/migrations/src/index.ts` exports the expected table list.
- `packages/migrations/src/runner.ts` implements migration lifecycle commands.
- `packages/migrations/migrations/*.sqlite.sql` and `*.postgres.sql` must evolve together.
- `packages/testing/src/fixtures/` owns SQLite-only deterministic fixture setup for local/system
  scenarios.
- `packages/testing/src/adapters/` owns mock role adapters and the test-only `HumanTestAdapter`.
- `packages/testing/src/conformance/` owns the smoke conformance runner and append-only result
  persistence.
- `packages/testing/src/scenarios/` owns registered scenario flows, including design-document
  lifecycle coverage.
- `infra/docker-compose.coder-sandbox.yml` owns coder-sandbox support services.
- `infra/docker-compose.test.yml` owns the disposable PostgreSQL service used by cross-dialect
  validation.

## Locked Architectural Invariants

Do not contradict these rules without an explicit architecture change to the canonical docs:

1. The MiniCoder database is authoritative for planning, workflow, review, event, cost, artifact,
   and design-document state.
2. GitHub is authoritative for repository, branch, commit, pull request, review, CI, mergeability,
   and merge state.
3. GitHub webhooks are primary; scheduled reconciliation is fallback and repair.
4. SQLite is the local/single-node state store. PostgreSQL is the hosted/team state store and is
   not deferred.
5. SQLite must never be used over a network filesystem.
6. Sequential feature execution is enforced by policy, locks/leases, lanes, and fencing tokens—not
   by a schema limitation.
7. Workflow Layer tasks are thin, idempotent wrappers around Orchestrator Core commands. Business
   rules belong in core; the current runtime is the in-repo DB-backed task queue.
8. `packages/core` remains free of provider SDKs and concrete database drivers.
9. Markdown artifacts are generated/importable snapshots, never runtime state.
10. Private chain-of-thought is never requested, persisted, logged, or exposed.
11. Every push, including a review fix, must re-enter CI before review or merge.
12. Task and event payloads carry IDs/references, schema versions, and secret-free data.

## Package Boundaries

### `@minicoder/core`

- Keep domain logic independent of SQLite, PostgreSQL, Workflow Layer runtimes, GitHub SDKs, and LLM providers.
- Import only abstractions into core.
- Access environment configuration only through `src/config/`.
- Keep adapter contracts provider-neutral and free of provider SDK imports.
- Validate adapter capabilities through `AgentCapabilitySchema`; do not accept ad hoc capability
  strings.
- Treat the adapter registry as the source of truth for active adapter configuration and capability
  matching.
- Add canonical state literals to `docs/00-glossary-and-terms.md` before adding them to
  `states.ts`.
- Export public contracts through `src/index.ts`.

The ESLint rules and `fitness/no-provider-imports.test.ts` enforce part of this boundary. Extend
fitness tests when introducing a new architectural restriction.

### Planning and clarification (`packages/core/src/commands/handlers/{planning,clarification}/`)

- `feature_requests.state` is a static label set once at backlog generation — it is never updated
  by transitions. The real execution-readiness gate is `feature_runs` rows, which
  `ActivatePlanHandler` inserts (one per `kind='feature'` request) when a plan activates.
- A `clarification_sessions` row's genesis is an `INSERT`, not a matrix transition — like
  `implementation_plans` starting at `draft`. `AssessPlanningReadinessHandler` creates it directly
  at `clarification_required` (insufficient) or `clarification_not_required` → immediately
  transitioned to `clarification_complete` (sufficient), and stamps `assessment_id` so later
  lookups (e.g. `GenerateImplementationPlanHandler`'s clarification-complete guard) can scope to
  the assessment in use instead of "the project's most recent session."
- `SubmitPlanForApprovalHandler` requires `backlog_validated_state = 'valid' AND
backlog_validated_version = backlog_version` on `implementation_plans` before a plan can leave
  `draft`. `GenerateFeatureBacklogHandler`/`ImportBacklogHandler` increment `backlog_version` and
  reset the `backlog_validated_*` columns to `NULL` every time they write features, so a stale
  validation from before the latest backlog change never counts.
- `RequestAnotherClarificationRoundHandler` requires every question in the current round to have an
  answer before reopening — the same guard `CompleteClarificationHandler` uses.
  `BlockClarificationHandler` is exempt: it is the circuit-breaker/timeout escape path and must stay
  usable precisely when answers did not arrive in time.
- `packages/triggerdev/src/tasks/validate-backlog.ts` must only catch the `CommandError` with
  `type: 'backlog-invalid'` and re-throw everything else — a bare `catch` that reports every error
  as `{ valid: false }` hides real infrastructure/programmer failures from the task queue's
  retry/failed-status handling.

### GitHub integration (`packages/github/`, `packages/core/src/github/`, `packages/core/src/commands/handlers/github/`)

- `GitHubClient` is an interface in core; the Octokit implementation lives only in
  `packages/github`. Orchestrator Core must remain free of Octokit and other provider SDK imports.
- `packages/github` is the webhook receiver package. It verifies GitHub signatures (including
  current/previous secret rotation), normalizes events, inserts inbox events, and exposes
  `minicoder github serve` for real deployments.
- `minicoder github serve` is not dev/test/ci-gated; it is the production webhook receiver. Keep the
  environment guard on `github simulate-*` helpers only.
- `reconcileGithubState()` is the single compare-and-dispatch algorithm. Webhook inbox handlers and
  the scheduled `github-reconciliation` task fetch observed GitHub state, then call this shared
  core function; do not fork reconciliation policy into either caller.
- `pull_requests.review_state` and `pull_requests.ci_status` are observed GitHub mirrors, not
  state-machine-governed columns.
- Reconciliation escalates irreconcilably closed-unmerged PRs to `human_required` from every
  non-terminal feature-execution state the check can reach. Do not narrow the matrix coverage to
  only early PR states.
- Review/fix-loop commands own review findings and aggregate fix-attempt counting; keep GitHub
  observation mirrors separate from reviewer-authored findings.
- `github-reconciliation` includes both tracked-PR reconciliation and missed-PR discovery through
  `GitHubClient.listPullRequestsForBranch()`/`discoverMissingPullRequests()`.

### Execution orchestrator, review loop, merge gate, and budget/cost

Relevant code: `packages/core/src/commands/handlers/{feature,automation,merge}/`,
`packages/core/src/cost/`, and `packages/core/src/merge-gate/`.

- Sequential execution uses two mechanisms with different purposes. `SelectFeatureHandler` owns the
  durable single-active-feature-per-project invariant with an atomic conditional update of
  `workflow_states.active_feature_run_id`. `ExecutionLane` owns short-lived lock/fence protection
  for mutations to an already-selected `feature_runs` row (`StartCodingHandler`,
  `RecordCodePushedHandler`, `StartFixingHandler`).
- `SelectFeatureHandler` takes no workflow lock; lock-gated feature-run mutation handlers must
  receive `envelope.lockContext` and assert the fence in the same transaction as the guarded write.
- `findNextEligibleFeatureRun()` is a deterministic read-side candidate picker only. It never
  mutates state and never replaces the dependency guard inside `SelectFeatureHandler`.
- `StartFixingHandler` (`changes_requested → fixing`) is used by the review/fix loop.
  `UnblockFeatureHandler` (`blocked → approved_pending_execution`) is exported for operator/API
  unblocking flows.
- `ApproveBudgetOverrideHandler` serves both budget override matrix edges
  (`paused_budget_exceeded → running` and `waiting_for_budget_approval → running`) from one
  handler. Callers must use the idempotency-key template matching the origin state they observed.
- `evaluateBudget()` is retrospective threshold evaluation only: it sums existing
  `cost_records.amount` rows live, applies optional `window_days`, and reports hard breaches before
  soft breaches. `forecastBudget()` is the prospective Phase 16 counterpart used as an opt-in
  pre-flight check by task wrappers. Do not introduce denormalized spend rollups without updating
  the canonical docs and tests.
- `RecordBudgetExceededHandler` and `RecordBudgetApprovalWaitingHandler` do not insert
  `cost_records` or `policy_decisions` rows. The cost record must already exist before evaluation;
  human override/resume handlers own policy-decision audit rows.
- `start-next-feature` uses `automationOperatorActor()` for `SelectFeatureCommand` because the
  task has no real authenticated operator session; do not weaken actor requirements in core.
- `evaluateMergeGate()` is the merge-policy engine. GitHub status-check publishing and merge
  operations belong behind the provider-SDK-free `GitHubClient` interface.

### `@minicoder/workflow`

- Keep workflow primitives database-backed, deterministic, and portable across SQLite and
  PostgreSQL.
- Call Orchestrator Core commands for business transitions; do not move domain policy into workflow
  wrappers.
- Preserve at-least-once dispatch semantics and idempotent handlers.
- Validate `payload_schema_version` and event payloads before invoking inbox handlers.
- Preserve deterministic backoff and the two-pass known/unknown event selection that prevents
  unknown event types from starving registered handlers.
- Treat heartbeat ownership loss as authoritative: do not mark a handler result after its claim is
  lost.
- Validate `staleClaimMs` as a finite integer greater than or equal to 2.
- Release locks by expiring and incrementing the stored fence; never delete the lock row and reset
  its fencing history.
- Run `assertFence` in the same transaction as the write it guards.

### Persistence packages

- Implement `PersistenceBackend`, `DbClient`, and `TxClient` from core.
- Keep dialect-specific SQL and driver behavior outside core.
- Preserve transaction rollback on failure.
- Preserve SQLite foreign-key enforcement and local WAL behavior.
- Account for genuine SQLite/PostgreSQL differences rather than pretending their concurrency
  models are identical.

### `@minicoder/triggerdev` / Workflow Layer task queue

- The package name is historical. **Trigger.dev has been removed**: no external Trigger.dev
  service, no 9-container stack, and no `@trigger.dev/sdk` dependency. The concrete runtime is an
  in-repo DB-backed task queue.
- Register only canonical task ID strings from `ALL_TASK_IDS`; no renames, aliases, or drift. Keep
  `TASK_REGISTRY` one-to-one with `ALL_TASK_IDS`.
- The Workflow Layer task `runImpl` functions call real core commands. Do not reintroduce
  payload-only stubs for canonical tasks.
- Task wrappers may sequence commands but must not change command semantics. Only expected
  domain-level invalid outcomes should be converted into structured task results; operational and
  unexpected errors must propagate so the DB-backed task queue can mark failures and retry.
- Task files build `CommandEnvelope`s and call `TransactionalCommandExecutor` — never import
  `StateTransitionValidator`/`TransitionError` or compare state enums directly
  (`fitness/no-domain-logic-in-task-wrappers.test.ts` enforces this).
- `runRegisteredTask()` links a task run to `triggerdev_runs`, executes the registered task
  implementation, and updates status. Keep `triggerdev_runs` as the stable async-run read model
  consumed by API/TUI/Web UI.
- `task_queue` is the queue-mechanics table: `task_id`, JSON `payload`, scoped idempotency key,
  status, attempts, retry timing, `project_id`, optional `linked_run_id`, redacted error summary,
  and optimistic `version`.
- `task_concurrency_gates` enforces per-task concurrency limits across multiple worker processes.
  Do not replace it with a process-local counter.
- `TaskQueueDispatcher` should mirror durable dispatcher patterns: stale-claim recovery, atomic
  optimistic-lock claim, heartbeat while work runs, deterministic exponential backoff, and
  redacted failure summaries.
- Each claimed task must run with its own `DbClient` connection via `runWithTaskDb`; do not run
  concurrently claimed tasks through the dispatcher's bookkeeping connection.
- Preserve `assertSchemaReady()` so workers fail fast on an unmigrated database, including missing
  `task_queue` or `task_concurrency_gates`.
- `minicoder tasks worker` is the long-running worker; `minicoder tasks drain` is the one-shot
  CI/test drain helper. Scaling means running more worker processes against the same database.
- `minicoder trigger ...` remains as a compatibility namespace over DB-backed functionality.
  `trigger deploy` has nothing external to deploy; `validate`, `list-runs`, `inspect-run`,
  `cancel-run`, `replay-run`, `drain-queue`, `reset-dev`, and `reconcile` operate on
  `task_queue`/`triggerdev_runs`.
- `start-next-feature` may dispatch two commands in one task invocation (`SelectFeatureCommand`
  then lock-gated `StartCodingCommand`) because `selected → coding` has no human/webhook gate
  between them. Expected races such as already-active feature, paused automation, stale candidate,
  unmet dependencies, or not found should be clean no-ops; unexpected failures should propagate.

### API, TUI, Web UI, and final design document

- `packages/api` is the Orchestrator API boundary. Keep read models side-effect-free, command
  dispatch authenticated/authorized, problem-details errors stable, and OpenAPI route parity tests
  passing.
- `packages/tui` and Phase 14-style CLI commands call the Orchestrator API over HTTP; do not add
  DB-direct behavior to those commands when extending an API-backed surface.
- `packages/web` uses a server-only API client; never expose the Orchestrator API key to client
  components or browser JavaScript. Mutations should use Server Actions with per-submission
  `Idempotency-Key` generation.
- `/design-document` has live generate/regenerate/revision/approve actions. `/adapters` remains
  read-only/disabled for adapter mutation until a backend adapter-registration command exists.
- Final design-document generation must collect evidence from database/GitHub mirror state, write
  all 13 canonical sections, export `final-design-document.md` as an artifact snapshot, and route
  human approval/revision through project lifecycle commands.
- Project acceptance validation is DB-knowable only. CI-only checks (full tests, migration
  validation, build, lint, security scan) must be reported as externally unverified when a command
  cannot run them without breaking layering.

### Migrations

- Every schema change must have equivalent SQLite and PostgreSQL migration paths.
- Keep migration names aligned across dialects:

```text
NNNN_description.sqlite.sql
NNNN_description.postgres.sql
```

- Update both expected-table declarations when tables change:
  - `packages/migrations/src/index.ts`
  - `packages/migrations/src/runner.ts`
- Add or update migration tests for constraints, indexes, idempotency, and validation.
- When adding uniqueness constraints to existing tables, include dialect-appropriate duplicate
  cleanup that matches the stated retention policy before creating the constraint.
- Use portable identifiers generated by the application.
- Store timestamps in UTC. Current SQLite migrations use ISO-8601 `TEXT`; PostgreSQL uses
  `TIMESTAMPTZ`.
- Do not place ad hoc dialect-specific DDL outside the migration layer.

### CLI

- Keep CLI handlers thin; delegate behavior to package APIs or runners.
- Preserve non-zero exit codes on failure.
- Guard destructive operations with explicit confirmation and environment/authorization checks as
  the relevant phase introduces them.
- `db reset` is destructive and requires both `--yes` and
  `--env <development|test|ci>`. The runner also rejects a non-safe `APP_ENV` or `NODE_ENV`.
- Never run `db reset` against an unknown, shared, or production database. Use a disposable
  database and verify the configured database identifier before invoking it.
- The `minicoder state` command group is Phase 4 database-backed tooling. `inspect`, `validate`,
  `doctor`, `reconcile`, `export-diagnostics`, and `repair` are implemented against the configured
  database. `state repair` requires `--project`, emits a time-boxed token on dry run, applies
  scoped orphaned-run repairs transactionally, and writes a `workflow_events` audit record.
- `state reconcile --project` is project-scoped for project-owned resources; global outbox/inbox
  queue reconciliation requires explicit `--all`.
- `db seed`, `db snapshot`, and `db restore` are SQLite-only development/CI helpers. `db seed` and
  `db restore` reject production `APP_ENV`/`NODE_ENV`; PostgreSQL fixture loading should use
  `pg_restore` or a purpose-built seed script.
- `github simulate-*` commands are development/test/CI helpers that insert synthetic inbox events
  and reject production `APP_ENV`/`NODE_ENV`.
- `github serve` is the real webhook receiver and is intentionally available for production
  deployments; do not add the dev/test/ci-only guard used by simulation commands.
- The `minicoder test` group is implemented: `unit` runs non-integration Vitest files,
  `integration` runs `*.integration.test.ts` files, `system` runs all registered scenarios, and
  `scenario <name>` runs one registered scenario.
- `minicoder tasks worker` runs the DB-backed Workflow Layer worker; `tasks drain` is the
  bounded one-shot drain command for CI/test use.
- The `minicoder trigger` command group remains as a compatibility/operations namespace over
  `task_queue`/`triggerdev_runs`: `validate`, `list-runs`, `inspect-run`, `cancel-run`,
  `replay-run`, `drain-queue`, `reset-dev`, and `reconcile` are DB-backed; `deploy` has no
  external Trigger.dev target.
- Destructive trigger reset requires `--yes` and `--env <development|test|ci>` and rejects unsafe
  or unset `APP_ENV`/`NODE_ENV` before deleting from `task_queue`.
- API-backed/TUI CLI groups include `status`, `plan`, `clarification`, `features`, `active`,
  `runs`, `findings`, `disagreements`, `costs`, `artifacts`, `adapters`, `design-doc`, `pause`,
  `resume`, `project`, `merge`, and related human/observability operations. Preserve their
  HTTP/API boundary when extending them.
- The glossary lists the target CLI surface. Verify a command is implemented before documenting it
  as currently available.

## Domain and Data Conventions

- Use exact canonical state and role tokens; do not invent aliases or near-matches.
- Feature IDs use `FR-<zero-padded-int>`, such as `FR-002`.
- Feature branches use `minicoder/FR-<n>`.
- The GitHub review-gate status check is `minicoder/review-gate`.
- All 19 canonical Workflow Layer task IDs are exact strings, no renaming/abbreviation
  permitted (`ALL_TASK_IDS`): `ingest-specification`, `planning-readiness-assessment`,
  `start-clarification`, `record-clarification-answer`, `complete-clarification`,
  `generate-implementation-plan`, `generate-feature-backlog`, `validate-backlog`,
  `request-plan-approval`, `activate-approved-backlog`, `start-next-feature`, `run-coder`,
  `run-review`, `run-merge-gate`, `github-reconciliation`, `export-plan`, `export-backlog`,
  `import-backlog`, and `run-design-doc`. Every canonical task is command-backed; task wrappers
  remain thin orchestration surfaces.
- Persisted mutable entities use optimistic versions.
- Locks use monotonically increasing fencing tokens; stale-fence writes must be rejected.
- Outbox and inbox events contain both `payload` and `payload_schema_version`.
- Inbox processing must validate the current schema version before invoking a handler and must be
  deduplicated.
- Unknown event types are deferred with `next_retry_at`; they must not consume attempts or starve
  registered handlers.
- Adapter roles are the canonical six-role set from the glossary: planner, coder, reviewer,
  documentation, arbiter, and human.
- Adapter capability tokens use the canonical `domain:name` shape and deterministic sorted order.
- Agent run records include immutable adapter/configuration provenance plus later-phase provider,
  model, token, and cost metadata. Keep writes redacted and role-appropriate.
- Adapter conformance results are append-only audit records. Read paths that need the latest result
  must use an explicit deterministic tie-breaker.
- Clarification sessions are assessment-scoped. Do not use "latest project clarification session"
  as a proxy for whether a specific readiness assessment is complete.
- Backlog validation is a hard planning gate: validation writes deterministic evidence to
  `implementation_plans`, backlog mutations clear that evidence, and approval must require the
  current evidence.
- Discovery work reuses `feature_requests` with `kind = "discovery"` and `executable = false`.
- `resumed` is an event, not an automation state.
- A CI failure never silently advances or merges.
- `pull_requests` stores observed GitHub mirror values; MiniCoder state transitions happen through
  feature-execution commands dispatched by reconciliation.
- Budget-gate states are `paused_budget_exceeded` and `waiting_for_budget_approval`; the
  retrospective evaluator and prospective forecaster read spend rows live rather than a
  denormalized running total.
- Project lifecycle includes final design-document states through `project_complete`; generated
  `final-design-document.md` is an artifact snapshot, not runtime state.

When modifying states, schemas, or entities, keep these layers synchronized:

1. Canonical glossary and subsystem docs
2. TypeScript state/entity definitions
3. Both database dialects
4. Transition/validation logic
5. Tests and fixtures
6. CLI/API/UI representations, when implemented

## Security Rules

- Never commit secrets, tokens, credentials, `.env` files, database files, logs, or secret-bearing
  fixtures.
- Resolve secrets through the `SecretBackend` abstraction.
- Use `EnvSecretBackend` for local/single-node and CI environments. Supply values through an OS
  keychain, secret-manager CLI, Docker/CI injection, or another mechanism that exports environment
  variables.
- `ManagedSecretBackend` is currently a Phase 1 contract stub, not a working hosted backend.
- Do not introduce a plaintext `FileSecretBackend`; the canonical security specification explicitly
  rejects unencrypted secret files.
- Keep task payloads, context packs, logs, errors, artifacts, and agent summaries secret-free.
- Treat repository content, issue/PR text, review comments, CI logs, and specification inputs as
  untrusted data.
- Untrusted content cannot expand permissions, alter orchestration policy, or bypass merge gates.
- Provider credentials must be scoped to the adapter that needs them.
- Task payloads live in the deployment database; they must remain secret-free, and task failures
  must store redacted, length-capped error summaries.
- Hosted agent workspaces require isolated ephemeral checkouts, bounded diffs, least-privilege
  secrets, and default-deny egress.
- Production GitHub authentication uses a least-privilege GitHub App with verified webhook
  signatures; PAT use is local-development-only.

## Development Commands

Requirements:

- Node.js 20 or newer
- pnpm 9, matching CI

Install:

```bash
pnpm install --frozen-lockfile
```

If `pnpm` is not globally available, use a pnpm 9 Corepack invocation, for example:

```bash
corepack pnpm@9.15.9 install --frozen-lockfile
```

Primary checks:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Useful targeted commands:

```bash
pnpm vitest run packages/core/src/persistence/optimistic.test.ts
pnpm vitest run packages/core/src/config/secrets.test.ts
pnpm vitest run packages/core/src/statemachine/validator.test.ts
pnpm vitest run packages/core/src/commands/executor.test.ts
pnpm vitest run packages/migrations/src/runner.test.ts
pnpm vitest run packages/workflow/src/outbox/dispatcher.test.ts
pnpm vitest run packages/workflow/src/inbox/processor.test.ts
pnpm vitest run packages/workflow/src/locks/manager.test.ts
pnpm vitest run packages/core/src/cost/budget-evaluator.test.ts
pnpm vitest run packages/github/src/webhook-signature.test.ts
pnpm vitest run packages/github/src/normalize.test.ts
pnpm vitest run packages/testing/src/github-reconcile.test.ts
pnpm vitest run packages/testing/src/testing.test.ts
pnpm tsx packages/cli/src/index.ts test scenario execution-orchestrator
pnpm tsx packages/cli/src/index.ts test scenario design-document-lifecycle
pnpm vitest run packages/triggerdev/src/triggerdev.test.ts
pnpm vitest run packages/triggerdev/src/task-registry.test.ts
pnpm vitest run packages/triggerdev/src/task-worker.test.ts
pnpm vitest run packages/cli/src/tasks.test.ts
```

SQLite migration smoke test:

```bash
DB_DIALECT=sqlite DB_PATH=/tmp/minicoder-agent.db pnpm db:migrate
DB_DIALECT=sqlite DB_PATH=/tmp/minicoder-agent.db pnpm db:validate
```

Destructive reset smoke tests must use a disposable database and both confirmation guards:

```bash
APP_ENV=development DB_DIALECT=sqlite DB_PATH=/tmp/minicoder-agent-reset.db \
  pnpm tsx packages/migrations/src/runner.ts reset --yes --env development
```

PostgreSQL migration validation requires a disposable database:

```bash
DB_DIALECT=postgres DB_URL=postgresql://... pnpm db:migrate
DB_DIALECT=postgres DB_URL=postgresql://... pnpm db:validate
```

Phase 4 lifecycle and system-test smoke checks:

```bash
APP_ENV=ci DB_DIALECT=sqlite DB_PATH=:memory: pnpm tsx packages/cli/src/index.ts test system
pnpm tsx packages/cli/src/index.ts test unit
pnpm tsx packages/cli/src/index.ts test integration
APP_ENV=development DB_DIALECT=sqlite DB_PATH=/tmp/minicoder-agent.db \
  pnpm tsx packages/cli/src/index.ts state doctor
```

Workflow Layer task registry smoke check:

```bash
pnpm --filter @minicoder/triggerdev build
pnpm --filter @minicoder/cli build
pnpm tsx packages/cli/src/index.ts trigger validate
APP_ENV=ci DB_DIALECT=sqlite DB_PATH=/tmp/minicoder-agent-tasks.db pnpm db:migrate
APP_ENV=ci DB_DIALECT=sqlite DB_PATH=/tmp/minicoder-agent-tasks.db \
  pnpm tsx packages/cli/src/index.ts tasks drain --timeout-ms 1000
```

Do not substitute SQLite-only validation for a required cross-dialect check.

## Testing Expectations

- Add regression tests with behavior changes.
- Unit tests must be deterministic, hermetic, and network-free.
- Default tests must not call real LLM providers, mutate real GitHub repositories, or require
  human interaction.
- Integration and migration changes must be validated against both SQLite and PostgreSQL.
- Scenario fixtures under `packages/testing/src/fixtures/` are SQLite-only unless explicitly
  documented otherwise; do not use them as PostgreSQL portability evidence.
- `pnpm audit --prod --audit-level=high` is the CI production dependency gate. Full local
  `pnpm audit --audit-level=high` currently reports documented Vitest/Vite dev-only advisories;
  upgrade them when feasible rather than weakening runtime dependency checks.
- Never call `db.close()` in SQLite tests; `better-sqlite3` native finalizers can double-free after
  explicit close. `vitest.config.ts` uses `pool: 'forks'` to isolate test-file teardown.
- Use disposable databases and deterministic fixtures.
- Test failure paths, retries, idempotency, constraint enforcement, rollback, and stale-write
  rejection—not only happy paths.
- New architecture boundaries should receive fitness tests.
- Preserve the Vitest convention `packages/*/src/**/*.test.ts`. Use `*.integration.test.ts` for
  tests that should be selected by `minicoder test integration`.

For a phase-level change, satisfy the Definition of Done in `docs/06-implementation-plan.md`:
schema changes, appropriate tests, canonical doc updates, runbook/diagnostic updates where relevant,
and a runnable demonstration scenario.

## TypeScript and Style

- TypeScript is strict with `noUncheckedIndexedAccess`, `noImplicitReturns`, and
  `noFallthroughCasesInSwitch`.
- Avoid `any`; tests are the only configured exception.
- Prefix intentionally unused parameters with `_`.
- Avoid import cycles.
- Use `.js` suffixes for local TypeScript imports, matching the existing source convention.
- Preserve root `pnpm typecheck` ordering for packages whose `types` point to generated `dist/`:

  ```text
  core → persistence-sqlite → persistence-postgres → workflow → github → adapters-* → triggerdev → testing → api → tui → web → recursive --noEmit
  ```

- Prefer small functions and explicit domain types over loosely shaped objects.
- Formatting is controlled by Prettier:
  - semicolons
  - single quotes
  - trailing commas
  - 100-column width
  - two-space indentation
- Do not add dependencies unless the existing stack cannot reasonably solve the problem.

## Documentation Changes

- Preserve each canonical document's `Status`, `Supersedes`, `Version`, and `Last-updated` header.
- Introduce shared vocabulary in `docs/00-glossary-and-terms.md` first.
- Do not create a second phase plan; update `docs/06-implementation-plan.md`.
- Keep architecture language provider-neutral. Provider implementations are adapters, not core
  dependencies.
- Clearly distinguish target architecture from currently implemented behavior.
- If a change invalidates a summary in `README.md` or `CLAUDE.md`, update the summary too.
- After terminology changes, grep for stale tokens and removed command names.

## Change Workflow

1. Read the relevant canonical docs and current implementation.
2. Identify the implementation phase and package boundary.
3. Write or update tests that lock the intended behavior.
4. Make the smallest coherent change.
5. Synchronize docs, types, migrations, and tests where the change crosses those layers.
6. Run targeted tests first.
7. Run the full verification suite.
8. Review `git diff` for accidental generated files, secrets, database files, or unrelated edits.

Do not overwrite unrelated user changes. Prefer deletion and reuse over new abstractions. Keep diffs
small, reviewable, and reversible.

## Completion Checklist

Before reporting completion:

- The change matches canonical vocabulary and architecture.
- Current behavior and target behavior are not conflated.
- Package boundaries remain intact.
- Both database dialects were updated when required.
- Tests cover success and meaningful failure paths.
- `test`, `typecheck`, `lint`, `format:check`, and `build` pass, or any unavailable check is
  explicitly reported.
- No secrets, generated artifacts, database files, or unrelated changes are present.
- Documentation and operations guidance are updated where required.
