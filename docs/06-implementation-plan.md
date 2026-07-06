# MiniCoder — Implementation Plan

> Status: Canonical
> Supersedes: minicoder_combined_implementation_plan.md,
> minicoder_combined_implementation_plan_testing_updated.md
> Version: 1.0.27
> Last-updated: 2026-07-05

This is the single canonical phase plan (18 phases). State names, adapter names, and the CLI
surface are defined in [`00-glossary-and-terms.md`](00-glossary-and-terms.md); architecture is
defined in [`01-system-specification.md`](01-system-specification.md).

## 1. Purpose

MiniCoder has one target architecture with local/single-node and hosted/team deployment profiles.
The implementation is phased, but there is no separate prototype system and production system.
Automated testing and state-lifecycle management are foundational requirements (Phase 4), not an
afterthought.

## 2. Phase Overview

| Phase | Name                                             | Outcome                                                                                    |
| ----- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1     | Repository and Persistence Foundation            | Monorepo; persistence abstraction; SQLite + PostgreSQL; migrations; core domain model      |
| 2     | State Machine, Idempotency, and Command Layer    | Valid lifecycle transitions; transactional, idempotent commands; outbox/inbox; locks/lanes |
| 3     | Workflow Layer Harness                           | Durable workflow execution from the start                                                  |
| 4     | Test Harness and State Lifecycle Tooling         | Automated test modes and lifecycle CLI commands                                            |
| 5     | Agent Adapter Foundation                         | Vendor-neutral adapters, mock/human adapters, conformance tests                            |
| 6     | Bootstrap Planner, Readiness, and Clarification  | Specification input becomes an approved database backlog                                   |
| 7     | GitHub Webhooks, Integration, and Reconciliation | Event-driven GitHub sync with reconciliation fallback                                      |
| 8     | Execution Orchestrator                           | Sequential, policy-driven feature execution                                                |
| 9     | Reference Coder Adapter                          | First replaceable Coder implementation                                                     |
| 10    | Reference Reviewer Adapter and Review/Fix Loop   | Structured review loop                                                                     |
| 11    | Disagreement, Arbiter, and Human Escalation      | Bounded disagreement resolution                                                            |
| 12    | Merge Gate and Branch Protection                 | Safe, policy-based merge                                                                   |
| 13    | Orchestrator API                                 | Stable command/query/webhook API                                                           |
| 14    | Ink Text UI                                      | Developer/operator terminal UI                                                             |
| 15    | Next.js Web UI                                   | Team-facing UI                                                                             |
| 16    | Observability, Cost, and Recovery                | Operational hardening                                                                      |
| 17    | Final Design Document Generator                  | Final system design document after completion                                              |
| 18    | Future Extensions                                | Parallel execution, multi-repo, additional adapters/SCM, PDF/DOCX                          |

> **Phases 1–8 are the platform kernel** (persistence, state machine, Workflow Layer, test harness,
> adapters, planner, GitHub integration, execution). Phases 9–17 are incremental capability layers
> on that kernel.

### Definition of Done (every phase)

A phase is complete only when it ships all of: schema migration(s) for any new tables; test
scenarios (unit/integration/system as applicable); updated canonical docs; an updated operations
runbook where the phase adds operable surface; diagnostics/state-doctor coverage for new state; and
a runnable demo scenario. Phase-specific acceptance criteria are additional to this baseline.

## Phase 1 — Repository and Persistence Foundation

Deliver a TypeScript/pnpm monorepo, shared lint/type/test setup, a **persistence abstraction**
supporting SQLite (local/single-node) and PostgreSQL (hosted/team), migration tooling, a database
access layer, core entity types, a **full ERD** (primary/foreign keys, cardinalities, uniqueness,
indexes, version columns, retention), the **config/secrets abstraction and environment modes**
(security foundation — see [`07-security-and-secrets.md`](07-security-and-secrets.md) §1), and basic
CI.

Acceptance: repository builds and tests run; SQLite works locally; the PostgreSQL path is
supported; migrations validate on **both** SQLite and PostgreSQL; migrations create the initial
schema; the ERD matches the migrations; secrets resolve only through the backend abstraction (no
plaintext at rest); no SQLite network-storage assumption exists; CI validates lint, types, and
tests.

## Phase 2 — State Machine, Idempotency, and Command Layer ✓

> **Status: Complete** (2026-06-13)

Deliver planning/execution/completion lifecycle states, the **full state-transition matrix**
(glossary §3.9 columns), a state-transition validator, a command handler framework, transactional
command execution, workflow event recording, idempotency keys, outbox/inbox tables, an outbox/inbox
dispatcher (scheduled Workflow Layer task or background worker), workflow locks/leases **with
fencing tokens**, execution lanes, **audit actor identity + local auth primitive +
secret-redaction tests** (security foundation, continued from Phase 1), and **architectural fitness
tests** (failing tests that encode invariants: no provider-SDK import in core; no domain logic in
task wrappers beyond the command interface; no `backlog.md` read at runtime; no secret in task
payloads — RF-12).

Acceptance: invalid transitions are rejected; valid transitions are persisted and evented; the
implemented transitions match the matrix; commands are idempotent and unit-tested; outbox/inbox
records are drained with at-least-once, idempotent dispatch; secret redaction is test-covered; the
fitness tests fail the build on any violated invariant; stale-fence writes are rejected;
**sequential execution is enforced by policy (locks/lanes), not by a schema invariant**.

**Delivered modules:**

- `packages/core/src/auth/` — `ActorIdentity`, `AuthContext`, `LocalAuthProvider`, `assertRole()`,
  `SecretRedactor` (RF-12)
- `packages/core/src/statemachine/` — `StateTransitionValidator`, `TransitionError`, and 8 machine
  matrices (feature-execution, plan-lifecycle, project-lifecycle, automation-control, agent-run,
  workflow-run, clarification, artifact-export)
- `packages/core/src/commands/` — `CommandEnvelope<P>`, `CommandResult<S>`, `CommandError` (RFC
  9457), `CommandHandler` interface, `CommandRegistry`, `TransactionalCommandExecutor`, and
  representative handlers for feature, plan, project, and automation commands
- `packages/core/src/events/schemas.ts` — per-event Zod schemas with `SCHEMA_VERSION`
- `packages/core/src/fitness/` — 3 new architectural fitness tests (`no-domain-logic-in-task-wrappers`,
  `no-backlog-md-at-runtime`, `no-secret-in-task-payloads`)
- `packages/workflow/` — new package: `WorkflowLockManager` (acquire/release/assertFence with
  fencing tokens), `ExecutionLane`, `OutboxDispatcher` (deterministic backoff), `InboxProcessor`,
  `IdempotencySweeper`
- `packages/migrations/migrations/0002_add_next_retry_at.*` — adds `next_retry_at` column to
  `outbox_events` and `inbox_events` for backoff scheduling
- `packages/cli/src/commands/state.ts` — `minicoder state` command group (inspect, validate,
  doctor, reconcile, export-diagnostics, repair)

## Phase 3 — Workflow Layer Harness

Deliver Trigger.dev project setup with **self-hosted single-node as the default backend** (Docker
Compose: 9-service v4 execution stack — init, Postgres, Redis, Electric, webapp, registry, MinIO,
docker-socket-proxy, supervisor), a GitHub Actions deployment workflow for Trigger.dev
tasks, the task-wrapper pattern, queue/retry config, waitpoint patterns, and Trigger.dev run
metadata linked to the database. Self-hosted HA cluster and Trigger.dev Cloud are drop-in backend
options selected by configuration, not code (see [`01-system-specification.md`](01-system-specification.md) §14).

Initial tasks (an **initial subset** of the full task families — not the complete planner family):

```text
planning-readiness-assessment
start-clarification
generate-implementation-plan
generate-feature-backlog
activate-approved-backlog
start-next-feature
github-reconciliation
export-plan
export-backlog
```

These names are the **exact** canonical token strings from
[`02-bootstrap-planner-clarification.md`](02-bootstrap-planner-clarification.md) §6 and are used
verbatim as the Trigger.dev task identifiers — no renaming or drift in the task wrappers. The
remaining planner tasks (ingest, record-answer, complete-clarification, validate-backlog,
request-approval, import-backlog) arrive with Phase 6.

This phase also treats the self-hosted Workflow Layer as a **real operated subsystem**: deliver
resource sizing for webapp/Postgres/Redis/worker, a version-upgrade strategy, backups for its
Postgres/Redis, and the operations runbooks in
[`04-testing-validation-state-lifecycle.md`](04-testing-validation-state-lifecycle.md) §11 — not
merely "tasks deploy and run." Webhook-secret management is established here (security foundation).

Task rule: Workflow Layer tasks call Orchestrator Core commands; they do not contain business rules
directly.

Acceptance: tasks deploy and run on the default self-hosted single-node backend; a mock task updates
the database through a core command; retry behavior is configured and idempotent; the waitpoint
pattern is proven with a simulated human approval; and the same tasks run unchanged against an
alternative backend (HA cluster or Cloud) selected by configuration only.

**Harness modules delivered (pending: core-command wiring in Phases 6–8):**

- `packages/triggerdev/` — new package: `TriggerConfig` + `loadTriggerConfig()` (config
  abstraction for three backends with validated backend string, fail-fast on invalid values),
  `assertSchemaReady()` (probes `triggerdev_runs` after connecting; task containers fail fast
  with an actionable message if the DB is empty or unmigrated rather than crashing inside
  `linkRunToDb()`), `linkRunToDb()` + `updateRunStatus()` + `getRunByTriggerdevId()`
  (idempotent upsert against the existing `triggerdev_runs` table; retries reuse the original row),
  `MockTriggerRunner` (canonical test seam for unit/integration tests), `ALL_TASK_IDS` constant
  (9 canonical task ID strings), and 9 task `runImpl` stubs (payload-validated via Zod; stub
  implementations are replaced with real core-command calls in Phases 6–8).
  `loadTriggerConfig()` and `applyTriggerEnv()` have no call sites in Phase 3; they are wired
  to runtime by Phases 6–8 as core commands are added.
- `packages/triggerdev/src/triggerdev-tasks.ts` — Trigger.dev task registration entry point; all 9
  tasks registered using `task()` from `@trigger.dev/sdk/v3`; `makeTaskRunner` wrapper parses
  payloads with Zod, handles DB lifecycle (idempotent linkRunToDb / updateRunStatus / close in
  try-finally), and status transitions use canonical `succeeded`/`failed` tokens
- `packages/triggerdev/trigger.config.ts` — Trigger.dev deployment configuration; project ref from
  `TRIGGER_PROJECT_REF` env var; `dirs` points to `./src` (directory, not file path)
- `infra/docker-compose.triggerdev.yml` — full v4 execution stack: init, Postgres, Redis, Electric
  (sync), webapp, Docker registry, MinIO (object store), docker-socket-proxy, and supervisor
  (worker); 9 services total; includes `triggerdev-init` (one-shot chown container). ClickHouse
  omitted for development (`RUN_REPLICATION_ENABLED=false`).
  Webapp auto-bootstraps a default worker group on first start via shared volume token handoff.
- `.github/workflows/trigger-deploy.yml` — CI/CD workflow: typecheck → build → verify task IDs →
  deploy with explicit `--env` and `--api-url`; CLI accepts `staging` or `prod` (not `production`);
  `TRIGGER_API_URL` is required and passed unconditionally — omitting it would silently target Cloud
- `packages/cli/src/commands/trigger.ts` — `minicoder trigger` command group scaffolded; `validate`
  is functional (reads `ALL_TASK_IDS` from the package); `list-runs` and `inspect-run` return
  static placeholder JSON only (not live data); all operational commands (`deploy`, `drain-queue`,
  `cancel-run`, `replay-run`, `reset-dev`, `reconcile`) exit 1 with "not implemented" until the
  API layer is wired in Phase 13
- `packages/core/src/fitness/no-domain-logic-in-task-wrappers.test.ts` — extended to scan
  `packages/triggerdev/src/tasks/` and `triggerdev-tasks.ts` for banned domain-logic patterns

**Remaining Phase 3 acceptance criteria (to be completed before marking done):**

- A task `runImpl` must call a real Orchestrator Core command and update domain state in the
  database (not just the `triggerdev_runs` metadata table). **Done for the 9 planner/clarification
  tasks as of Phase 6** (Bootstrap Planner) **and for `github-reconciliation` as of Phase 7**;
  `start-next-feature` remains a stub pending Phase 8.
- The waitpoint pattern is proven at the in-process level (deferred Promise / external signal); a
  durable Trigger.dev waitpoint test requires a live Trigger.dev environment and is deferred to
  Phase 4's dedicated Trigger.dev integration test job.

## Phase 4 — Test Harness and State Lifecycle Tooling

Deliver the unit/integration/system test harness, mock adapters, a mock GitHub provider, a
Trigger.dev test-harness wrapper, the database lifecycle CLI, the Trigger.dev lifecycle CLI, the
state doctor, GitHub event simulation, the scenario runner, a Docker Compose test flow, and
Kubernetes Job test templates. The full CLI surface is defined in
[`00-glossary-and-terms.md`](00-glossary-and-terms.md) §5; behaviors are specified in
[`04-testing-validation-state-lifecycle.md`](04-testing-validation-state-lifecycle.md).

Acceptance: system tests run without real LLM calls; the integration suite runs as a **cross-dialect
matrix against both SQLite and PostgreSQL** (see [`04-testing-validation-state-lifecycle.md`](04-testing-validation-state-lifecycle.md) §8);
a Docker Compose scenario runs unattended; destructive commands are guarded; CI can run a system
smoke scenario.

## Phase 5 — Agent Adapter Foundation ✓

> **Status: Complete** (2026-06-30)

Deliver the six role interfaces, an adapter registry, the capability model, the six role adapters
(including `HumanTestAdapter`), adapter run records, and adapter conformance tests (see
[`03-agent-adapter-architecture.md`](03-agent-adapter-architecture.md)).

Acceptance: core does not depend on provider SDKs; mock adapters are invoked directly by the
conformance runner and `AgentRunRecorder` (Workflow Layer task-wrapper invocation of adapters is
architecturally scoped in `03-agent-adapter-architecture.md` §10 but is **not** part of Phase 5's
completed scope — see "Smoke conformance scope" below); `agent_runs` records are created;
capability validation works; and the conformance framework runs all six role adapters (including
`HumanTestAdapter`) to green, writing `adapter_conformance_results`. (Provider-adapter conformance
fixtures for additional adapters are
Phase 18.)

**Delivered modules:**

- `packages/core/src/adapters/types.ts` — the six role interfaces (`PlannerAgentAdapter`,
  `CoderAgentAdapter`, `ReviewerAgentAdapter`, `ArbiterAgentAdapter`,
  `DocumentationAgentAdapter`, `HumanAgentAdapter`) + all per-role `Input`/`Output` types and
  `AdapterCall<I, O>`, moved from `packages/testing` so that Phase-9+ reference adapters can
  implement these interfaces without depending on the testing package.
- `packages/core/src/adapters/capabilities.ts` — `AgentCapabilitySchema` (Zod enum of the 15
  canonical tokens from `03` §3), `AgentCapabilityToken` type, `CapabilityError`,
  `validateCapabilities(adapterId, declared, required)`. Named `AgentCapabilityToken` (not
  `AgentCapability`) to avoid collision with the `AgentCapability` entity interface in
  `domain/entities.ts`.
- `packages/core/src/adapters/registry.ts` — `AdapterRegistry`: idempotent `register()` (upsert
  on role + name, replacing capabilities on re-registration), `resolve(role, name)` (active adapters
  only), `getById(adapterId)`, `assertCapabilities(adapterId, required)`, and
  `getConfiguration(adapterId, projectId?)` (project-scoped row preferred over adapter-default).
  All reads run against `agent_adapters`/`agent_capabilities`/`agent_configurations`.
  `UnknownAdapterError` is thrown for missing or inactive entries.
- `packages/core/src/adapters/run-recorder.ts` — `AgentRunRecorder.record<O>(opts, fn)`: drives
  the `agent-run` state machine (QUEUED → RUNNING → SUCCEEDED / FAILED) using
  `StateTransitionValidator` with `AGENT_RUN_MATRIX`; redacts secrets from input/output via
  `SecretRedactor` before persisting; records `agent_errors` rows on failure with a normalized
  `AgentRunErrorType`; re-throws the original error so callers can propagate. `AdapterRunError`
  carries the typed `errorType` for normalized taxonomy dispatch.
- `packages/core/src/adapters/test-helpers.ts` — `InMemoryAdapterDb`: lightweight in-memory
  `DbClient` fake for unit tests in `packages/core` (which has no DB driver dependency).
- `packages/core/src/adapters/*.test.ts` — unit tests for `capabilities.ts` (schema + validator),
  `registry.ts` (register/resolve/assertCapabilities/getConfiguration), and `run-recorder.ts`
  (succeeded run, failed run with error_type dispatch, secret redaction), all using
  `InMemoryAdapterDb`.
- `packages/testing/src/adapters/types.ts` — converted from a declaration file to a thin
  re-export shim targeting `@minicoder/core`; all mock classes and scenario code continue to
  `import from './types.js'` unchanged.
- `packages/testing/src/conformance/` — new conformance-scenario runner:
  `runConformanceSuite({ db, registry, recorder })` iterates over all six mock adapters
  (one per role), runs 9 scenarios per adapter (capability declaration, successful run, failure
  handling, invalid-output handling, secret redaction, configuration resolution, state-transition
  sequence, output-shape validation, assertCapabilities), and writes one
  `adapter_conformance_results` row per adapter. The `details` JSON snapshot includes
  `adapterName`, `implementation`, `version`, and `capabilities` alongside the scenario results so
  historical records remain attributable after adapter re-registration. All 6 adapters × 9
  scenarios = 54 scenario executions total; 5 are skipped (`invalid_output_handling` for the 5
  non-Coder adapters), 49 pass, 0 fail.
- `packages/core/src/index.ts` — new `// Phase 5: agent adapters` export section.
- `packages/migrations/migrations/0003_unique_adapter_role_name.*` — adds a unique index on
  `agent_adapters(role, name)` for both SQLite and PostgreSQL, preventing concurrent duplicate
  registrations. Each file includes a preflight comment with a diagnostic query to identify and
  remove any duplicate rows before applying the migration.
- `AdapterRegistry.register` uses `INSERT ... ON CONFLICT (role, name) DO NOTHING` rather than
  catching a unique-constraint error inside the transaction: in PostgreSQL, a failed `INSERT`
  aborts the enclosing transaction, so any later query in that same transaction fails with
  "current transaction is aborted" — `DO NOTHING` never errors, keeping the transaction usable.
  `packages/migrations/src/registry.postgres.test.ts` (gated on `MINICODER_TEST_PG_URL`, same as
  `runner.postgres.test.ts`) registers the same `(role, name)` twice against a real PostgreSQL
  connection and asserts the same adapter id is returned, `version` increments, capabilities are
  replaced, and the connection remains usable afterward.
- `packages/migrations/migrations/0004_agent_runs_provenance.*` — adds four immutable provenance
  columns to `agent_runs`: `adapter_name TEXT`, `adapter_implementation TEXT`,
  `adapter_version INTEGER`, and `capabilities_used TEXT`. `AgentRunRecorder` resolves these
  automatically from the `AdapterRegistry` at invocation time — callers cannot supply or override
  them — so historical records remain attributable after adapter re-registration. The recorder
  also validates the caller-supplied `role` against the registry record (throwing
  `RunRoleMismatchError` on mismatch) and validates `capabilitiesUsed` is a subset of the
  adapter's declared capabilities (throwing `UndeclaredCapabilityError` otherwise), so a run row
  can never misrepresent which role or capabilities were actually in play. `capabilitiesUsed` is a
  **required** field on `RecordRunOptions` (not defaulted to `[]`) so a capability-bearing run
  cannot silently persist an empty `capabilities_used` record; callers pass `[]` explicitly only
  for calls that genuinely exercise no declared capability. The conformance runner passes each
  descriptor's `requiredCapabilities` at every `recorder.record()` call site, and
  `conformance.test.ts` asserts `agent_runs.capabilities_used` is non-empty for every run the
  suite creates.
- `packages/core/src/domain/entities.ts` — `AgentRun` gains `adapterName`, `adapterImplementation`,
  `adapterVersion`, and `capabilitiesUsed` fields (all nullable, matching the additive migration
  semantics for pre-migration rows), keeping the domain type in sync with the schema.
  `AdapterConformanceResult` gains `skippedTests: number` matching migration 0005.
- `packages/migrations/migrations/0005_conformance_skipped_tests.*` — adds `skipped_tests INTEGER
NOT NULL DEFAULT 0` to `adapter_conformance_results`, tracking how many scenarios were
  intentionally skipped (e.g. `invalid_output_handling` is N/A for non-Coder adapters).
- `packages/core/src/adapters/capabilities.ts` — new `parseCapabilities(capabilities, source)`:
  validates every entry against `AgentCapabilitySchema`, dedupes, and sorts the result by
  canonical schema order (the token's position in `AgentCapabilitySchema`), throwing
  `InvalidCapabilityError` (listing every offending value) rather than silently casting an
  unrecognized string to `AgentCapabilityToken`. `AdapterRegistry.register()` calls it on
  caller-supplied input before the transaction opens; `toRecord()` calls it on capability rows
  read back from `agent_capabilities`, so a corrupted DB row fails loudly instead of defeating
  `assertCapabilities` silently. Canonical-order sorting (rather than an `ORDER BY created_at,
id` on the read query) makes the returned capability array deterministic across storage
  engines and independent of physical row order — capability rows inserted in the same
  registration call share an identical `created_at` timestamp, so timestamp-based ordering
  alone would not have been reliably deterministic.
- `packages/migrations/migrations/0006_unique_agent_configurations.*` — adds two partial unique
  indexes on `agent_configurations`: `uq_agent_configurations_default` on `(adapter_id)` where
  `project_id IS NULL` (at most one default config per adapter), and
  `uq_agent_configurations_project` on `(adapter_id, project_id)` where `project_id IS NOT NULL`
  (at most one config per adapter/project pair). Both dialects support partial/filtered unique
  indexes; SQLite's plain `UNIQUE(adapter_id, project_id)` would not have caught duplicate
  default rows since SQL treats every `NULL` as distinct. `AdapterRegistry.getConfiguration()`
  adds a `version DESC, updated_at DESC` tiebreaker as defense-in-depth in case this invariant is
  ever violated by a direct DB write.
- The conformance runner's `configuration_resolution` scenario upserts (SELECT-then-UPDATE-or-
  INSERT) its default config row instead of an unconditional INSERT, because migration 0006's
  unique index makes a second unconditional INSERT for the same (idempotently re-registered)
  adapter fail. `runConformanceSuite()` is safe to re-run against a persistent DB;
  `conformance.test.ts` has a regression test asserting two consecutive runs both pass.
- `adapter_conformance_results` is **append-only** — there is no unique key on
  `(test_suite, adapter_id)` and `runConformanceSuite()` never upserts, so every call inserts a
  fresh row per adapter even when re-run against the same DB with the same adapters. This is
  intentional: the table is a historical audit log of every conformance run, not a single
  current-gate-state row. Consumers that want "the current result for an adapter" must query
  `ORDER BY run_at DESC LIMIT 1` scoped to `(test_suite, adapter_id)`. `conformance.test.ts` has
  tests asserting a rerun appends exactly 6 new rows (documenting the intended semantics as a
  regression guard) and demonstrating the latest-row query pattern.
- The SQLite preflight remediation comments in migrations `0003_unique_adapter_role_name.sqlite.sql`
  and `0006_unique_agent_configurations.sqlite.sql` previously suggested `MAX(rowid)` to select
  which duplicate row to keep, but `rowid` reflects insertion order, not `updated_at` — it did not
  match the "keep the most-recently-updated row" policy the comment stated (the PostgreSQL
  guidance already used `updated_at DESC` correctly). Both files now use a `ROW_NUMBER() OVER
(PARTITION BY ... ORDER BY updated_at DESC, id DESC)` window-function query instead, matching
  the stated policy with a stable tiebreaker.

**Deferred to Phase 9–10.** Provider-level fields (`provider`, `model`, `triggerdev_run_id`,
`prompt_template_version`, and artifact-reference columns) are **not** added to the schema in
Phase 5. They will be introduced when real provider connections are established (Phase 9 —
Reference Coder Adapter; Phase 10 — Reference Reviewer Adapter). Writing dummy values here would
create misleading data in production runs.

**Smoke conformance scope.** The Phase 5 conformance suite (`phase5-smoke-conformance`) verifies
adapter wiring: capability declaration, successful run, failure handling, secret redaction,
configuration resolution, state-transition sequence, output-shape validation, and
assertCapabilities. The `invalid_output_handling` scenario runs only for `MockCoderAdapter`; the
other five adapters skip it (skipped scenarios do not count as failures). Timeout taxonomy, cost
and token reporting, and Workflow Layer wrapper invocation are deferred to the full canonical
adapter contract in Phase 9+.

**Existing tables.** The `agent_adapters`, `agent_capabilities`, `agent_configurations`,
`agent_runs`, `agent_errors`, `agent_tool_operations`, `agent_context_packs`, and
`adapter_conformance_results` tables were created in `0001_initial_schema.*` (Phase 1). Migrations
0003–0006 extend them without recreating any tables.

## Phase 6 — Bootstrap Planner, Readiness, and Clarification ✓

> **Status: Complete** (2026-07-01)

Deliver specification ingestion, Planning Readiness Assessment, clarification sessions/questions/
answers, assumption and gap records, plan generation, feature-request generation, dependency/
acceptance-criteria/test-expectation generation, human approval, backlog activation, and
plan.md/backlog.md export/import (see [`02-bootstrap-planner-clarification.md`](02-bootstrap-planner-clarification.md)).

Acceptance: sufficient input generates a draft plan; insufficient input creates clarification
questions; blocking gaps prevent activation; an approved plan activates features as
`approved_pending_execution`; no runtime logic reads `backlog.md` as a source of truth.

**Delivered modules:**

- `packages/migrations/migrations/0007_clarification_sessions.*` — new tables
  `clarification_sessions` (persists the `ClarificationStatus` machine — round, `max_rounds`,
  `round_timeout_at`), `clarification_questions` (per-round questions, now including
  `answered_at`), `clarification_answers` (one row per question, unique on
  `clarification_question_id`), and `clarification_decisions` (records circuit-breaker /
  completion decisions); adds a nullable `clarification_session_id` column to `planning_gaps` and
  `planning_assumptions` (docs/02 §4 — gaps/assumptions reuse the existing tables rather than
  duplicating them). `EXPECTED_TABLES` grows from 43 to 47.
- `packages/core/src/domain/states.ts` — new `ClarificationStatus` const/type (moved out of
  `statemachine/machines/clarification.ts`, which now imports it, so the status enum has a single
  canonical source like every other machine); `WorkflowTaskId` extended with the 6 remaining
  canonical task IDs from docs/02 §6.
- `packages/core/src/domain/entities.ts` — new `ClarificationSession`, `ClarificationQuestion`,
  `ClarificationAnswer`, `ClarificationDecision` entities; `PlanningGap`/`PlanningAssumption` gain
  `clarificationSessionId`.
- `packages/core/src/commands/handlers/planning/` — ten new command handlers:
  `IngestSpecificationHandler`, `AssessPlanningReadinessHandler` (resolves `PlannerAgentAdapter`
  via `AdapterRegistry` and records the call through `AgentRunRecorder`; also creates/settles the
  project's `clarification_sessions` row), `GenerateImplementationPlanHandler`,
  `GenerateFeatureBacklogHandler`, `ValidateBacklogHandler` (cycle detection + acceptance/test
  coverage gate over `feature_dependencies`), `SubmitPlanForApprovalHandler`, `ActivatePlanHandler`
  (inserts one `feature_runs` row per `kind='feature'` request — see design note below),
  `ExportPlanHandler`/`ExportBacklogHandler` (drive the `artifact-export` matrix end to end into
  markdown `artifact_exports.content`), and `ImportBacklogHandler`.
- `packages/core/src/commands/handlers/clarification/` — five new handlers covering every
  `CLARIFICATION_MATRIX` transition: `StartClarificationHandler`,
  `RecordClarificationAnswerHandler` (data-only — does not transition session status),
  `CompleteClarificationHandler`, `RequestAnotherClarificationRoundHandler`,
  `BlockClarificationHandler` (the clarification circuit breaker from docs/02 §4).
- **Design note — `feature_requests.state` stays a static label.** `ActivatePlanCommand`'s
  documented side effect `set_feature_requests_to_approved_pending_execution` is implemented as
  inserting `feature_runs` rows (the actual execution-readiness gate — see
  `select-feature.ts`), not by mutating `feature_requests.state`, which is set once at backlog
  generation and never touched again.
- `packages/triggerdev/src/tasks/` — all 9 previously-stubbed tasks now call real core commands
  through `TransactionalCommandExecutor`; 6 new task files (`ingest-specification`,
  `record-clarification-answer`, `complete-clarification`, `validate-backlog`,
  `request-plan-approval`, `import-backlog`) bring `ALL_TASK_IDS` from 9 to the full 15 canonical
  task IDs. `packages/triggerdev/src/tasks/actor.ts` builds the system/human `ActorIdentity` task
  payloads carry (Phase 13's API layer will replace the human-actor payload fields with real
  session identity). `planning-readiness-assessment` and `generate-implementation-plan` never
  import a concrete adapter — the `PlannerAgentAdapter` instance is injected by the caller, so a
  live Trigger.dev deployment fails fast with an actionable error until a reference/generic
  planner adapter exists (none has shipped yet; docs/02 §7 names `GenericLLMPlannerAdapter` as a
  future implementation, out of Phase 6 scope).
- `packages/triggerdev/src/triggerdev-tasks.ts` / `mock-runner.ts` — `makeTaskRunner` and
  `MockTriggerRunner.run()` now pass the resolved `DbClient` (and, for planner-invoking tasks, the
  injected adapter) through to `runImpl`; the fitness test
  (`no-domain-logic-in-task-wrappers.test.ts`) continues to pass unchanged — task files only build
  `CommandEnvelope`s and call the executor, never import a `StateTransitionValidator` or compare
  state enums directly.
- `packages/testing/src/runner.ts` — registers `MockPlannerAdapter` into the DB-backed
  `AdapterRegistry` before every scenario run, so commands that resolve `PlannerAgentAdapter` by
  name can find it.
- `packages/testing/src/scenarios/planning-basic.ts`, `clarification-required.ts`,
  `backlog-activation.ts` — rewritten to invoke the real tasks (which now call real commands) and
  assert on the resulting `clarification_sessions`/`feature_runs` rows, instead of inlining raw SQL
  and direct planner calls as a stand-in for the not-yet-wired task layer.
- No new CLI command group was added — the canonical CLI surface
  (`00-glossary-and-terms.md` §5) has no `minicoder plan`/`backlog` group; Phase 6 is driven
  through Workflow Layer tasks and `minicoder test scenario` only, consistent with the existing
  surface.

**Post-implementation review fixes** (`packages/migrations/migrations/0008_backlog_validation_tracking.*`):

- `implementation_plans` gains a version-scoped backlog-validation record —
  `backlog_version` (incremented by `GenerateFeatureBacklogHandler`/`ImportBacklogHandler` every
  time a plan's features are (re)written, which also clears the columns below),
  `backlog_validated_at`, `backlog_validated_state`, and `backlog_validated_version` (written by
  `ValidateBacklogHandler`). `SubmitPlanForApprovalHandler` now requires
  `backlog_validated_state = 'valid' AND backlog_validated_version = backlog_version` before a plan
  can leave `draft` — previously it only checked unresolved blocking `planning_gaps`, so a plan
  could reach `pending_approval` with an empty, cyclic, or under-tested backlog.
- `clarification_sessions` gains a nullable `assessment_id` column, set by
  `AssessPlanningReadinessHandler` at creation time. `GenerateImplementationPlanHandler`'s
  clarification-complete guard now looks up the session tied to the assessment being used instead
  of "the project's most recent clarification session," which could wrongly block or wrongly allow
  plan generation once a project has more than one readiness assessment.
- `RequestAnotherClarificationRoundHandler` gained the same unanswered-current-round-questions
  guard `CompleteClarificationHandler` already had, so `complete-clarification.ts`'s
  insufficient-readiness path can no longer reopen a round while questions remain unanswered.
  `BlockClarificationHandler` is intentionally exempt — it is the circuit-breaker/timeout escape
  path and must stay usable precisely when answers did not arrive in time.
- `packages/triggerdev/src/tasks/validate-backlog.ts` now narrows its `catch` to only the expected
  `CommandError` (`type: 'backlog-invalid'`) and re-throws everything else, so infrastructure
  failures and "plan not found" errors surface as real task failures (with Trigger.dev retry)
  instead of being reported as a successful `{ valid: false }` run.
- **Issue #31 (found after the round above shipped):** `SubmitPlanForApprovalHandler`'s
  unresolved-blocking-`planning_gaps` check had the identical project-vs-assessment scoping bug the
  round above fixed for `GenerateImplementationPlanHandler`'s clarification guard, just missed in
  that pass — it joined `planning_gaps` through `planning_readiness_assessments.project_id` instead
  of filtering directly on the plan's own `assessment_id` (already available on
  `implementation_plans`), so an unresolved blocking gap tied to an unrelated assessment in the same
  project could permanently block submission of a plan that has nothing to do with that assessment.
  Fixed by scoping the query to `pg.assessment_id = {implementation_plans.assessment_id}` (a plan
  with no `assessment_id`, e.g. an imported one, has no assessment-scoped gaps to block on).
  Regression in `packages/triggerdev/src/triggerdev.test.ts`: two assessments in one project, each
  with its own unresolved blocking gap — submitting a plan generated from assessment A succeeds
  once assessment A's gap is resolved, even while assessment B's gap remains unresolved.
- `GenerateFeatureBacklogPayload`'s Trigger.dev schema (`packages/triggerdev/src/tasks/types.ts`)
  changed `features` from `.default([])` to `.min(1)`, matching
  `GenerateFeatureBacklogHandler`'s own schema; the task no longer has an empty-payload no-op
  short-circuit that silently "succeeded" with zero features written.

## Phase 7 — GitHub Webhooks, Integration, and Reconciliation ✓

> **Status: Complete** (2026-07-02)

Deliver a GitHub webhook receiver with signature verification, inbox processing, the GitHub API
client, branch/PR operations, review/check/mergeability reading, status-check publication, a
scheduled reconciliation service, pre-flight checks (including the capacity/rate-limit pre-flight),
GitHub link records, and the **full GitHub integration contract** (webhook events consumed, dedup
key, GitHub App permissions, branch naming, PR labels, the `minicoder/review-gate` status
check, merge method, force-push policy, and the reconciliation algorithm — see
[`01-system-specification.md`](01-system-specification.md) §5.7).

Acceptance: webhook deliveries are persisted to the inbox and processed durably; MiniCoder can
detect/create branches and PRs; database/GitHub mismatches are reconciled or marked `human_required`;
GitHub operations are evented.

**Delivered modules:**

- `packages/migrations/migrations/0009_pull_requests.*` — new `pull_requests` table (one row per
  `feature_run_id`): `pr_number`, `branch_name`, `base_branch`, `head_sha`, `state` (open/closed/
  merged), `review_state` (mirrors `PrReviewState`), `ci_status`, `mergeable`, `blocking_labels`
  (JSON), `conversations_resolved`, `merged_at`, `merge_sha`, `closed_at`. `review_state`/
  `ci_status` are observed GitHub mirrors with no `StateTransitionValidator` matrix — GitHub
  remains authoritative. `EXPECTED_TABLES` grows from 47 to 48.
- `packages/core/src/github/client.ts` — the provider-SDK-free `GitHubClient` interface
  (`createBranch`, `createPullRequest`, `getPullRequest`, `publishStatusCheck`,
  `getRemainingRateLimit`) and `ObservedPullRequestState`; Orchestrator Core never imports
  Octokit.
- `packages/core/src/github/reconcile.ts` — `reconcileGithubState()`, the single reconciliation
  algorithm (docs/01 §5.7) both the webhook-triggered inbox handlers and the scheduled
  `github-reconciliation` fallback call, so they can never diverge. Given an already-fetched
  `ObservedPullRequestState`, it advances the feature-execution matrix one `Record*Command` at a
  time, escalates to `human_required` on irreconcilable divergence (PR closed unmerged while
  `pr_opened`/`ci_running`), or no-ops when consistent.
- `packages/core/src/commands/handlers/github/` — five new command handlers:
  `RecordPrOpenedHandler`, `RecordCiRunningHandler` (both lock-fence-gated, matching
  `RecordCodePushedHandler`'s pattern), `RecordCiPassedHandler` (→ `under_review`),
  `RecordCiFailedHandler` (→ `ci_failed`), `RecordChangesRequestedHandler`. Each upserts the
  matching `pull_requests` row alongside the `feature_runs` state transition.
- `packages/core/src/statemachine/machines/feature-execution.ts` — two new matrix transitions,
  `pr_opened → human_required` and `ci_running → human_required` (both via
  `EscalateToHumanCommand`), covering the GitHub-reconciliation irreconcilable-divergence path
  that previously had no matrix entry. **Post-implementation review fix:** a later review round
  found `reconcileGithubState()`'s `irreconcilablyClosed` check targets _every_ non-terminal
  feature-execution state, not just `pr_opened`/`ci_running` — the matrix was extended with
  `EscalateToHumanCommand` entries for the remaining 12 non-terminal states (some, like
  `ci_failed`/`under_review`/`merge_failed`/`system_failed`, already had an entry for a different
  guard reason and gained GitHub-reconciliation as an additional trigger; the rest —
  `approved_pending_execution`, `selected`, `coding`, `code_pushed`, `changes_requested`, `fixing`,
  `approved_by_policy`, `merge_ready` — were new), so all 14 non-terminal states now correctly
  escalate. See `docs/01-system-specification.md` §5.7 and `docs/00-glossary-and-terms.md` §3.9
  for the current, authoritative list.
- `packages/github` (new package) — `OctokitGitHubClient` (the sole Octokit import site in the
  repo; pinned to `@octokit/rest@^19`/`@octokit/webhooks-methods@^3`, the last CJS-compatible
  majors, since the repo's TypeScript output target is CommonJS and current Octokit majors are
  ESM-only), `verifyWebhookSignature()` (current + previous secret rotation window, via
  `@octokit/webhooks-methods`), `normalizeGithubWebhookEvent()` (raw GitHub `(event, action)` →
  the internal taxonomy `minicoder github simulate-*`/`MockGitHubProvider` already use),
  `createWebhookApp()` / `registerGithubWebhookRoute()` (a minimal Fastify app exposing
  `POST /webhooks/github`, reused as-is by Phase 13's future orchestrator API instead of being
  reimplemented), and `createGithubInboxHandlers()` (the `InboxHandler` registrations for
  `pr.opened`, `pr.synchronized`, `pr.closed`, `pr.merged`, `check.passed`, `check.failed`,
  `review.approved`, `review.changes_requested`, `review.dismissed`, resolving the affected
  feature run via an existing `pull_requests` row or via the `minicoder/<frId>` branch-naming
  convention, then delegating to `reconcileGithubState()`).
- `packages/triggerdev/src/tasks/github-reconciliation.ts` — real `runImpl`: for the requested
  project (or single feature run), resolves the linked repository, fetches current
  `ObservedPullRequestState` for every feature run that already has a tracked `pull_requests` row,
  and calls `reconcileGithubState()`. GitHub credentials are resolved from `GITHUB_TOKEN` at
  runtime (fails fast with an actionable error if unset) rather than injected the way
  `PlannerAgentAdapter` is, since a GitHub credential is a single deployment-wide secret, not a
  per-call dependency. Discovering a brand-new PR with no prior webhook/`pull_requests` row is
  deferred — `GitHubClient` has no "list PRs by branch" method yet (tracked in
  [issue #35](https://github.com/jhoar/MiniCoder/issues/35); an interim manual-recovery runbook
  exists in `docs/04-testing-validation-state-lifecycle.md`'s Phase 7 runbook section).
- `packages/cli/src/commands/github.ts` — new `minicoder github serve` command (added to
  `00-glossary-and-terms.md` §5), a thin wrapper around `createWebhookApp()`; unlike
  `simulate-*`, it is **not** gated by the dev/test/ci `guardEnv()` check, since it is the real
  webhook receiver and is expected to run in production/hosted deployments. Also fixed a latent
  bug where `simulate-*` wrote `payload_schema_version = '1.0'` instead of the actual
  `SCHEMA_VERSION` (`'1.0.0'`), which would have made every simulated event fail
  `InboxProcessor`'s schema-version check.
- `packages/testing/src/services/mock-github-client.ts` — `MockGitHubClient implements
GitHubClient`, wrapping `MockGitHubProvider` so scenario tests drive GitHub state via the
  existing `simulate*` surface while `reconcileGithubState()` observes it through the same
  interface `OctokitGitHubClient` implements.
- `packages/testing/src/scenarios/github-race.ts` / `fixtures/github-race.ts` — rewritten to
  invoke the real `github-reconciliation` task (via `MockTriggerRunner`, injecting
  `MockGitHubClient` as the client-factory `extra` argument) and assert on the resulting
  `feature_runs`/`pull_requests` rows, instead of inlining raw SQL; no longer writes
  `feature_requests.state` (the earlier placeholder violated the static-label rule).
- New unit tests: `packages/github/src/webhook-signature.test.ts`,
  `packages/github/src/normalize.test.ts`, `packages/testing/src/github-reconcile.test.ts`
  (8 cases covering every `reconcileGithubState()` branch: PR-opened creation, CI running/passed/
  failed, changes-requested, irreconcilable escalation, and both no-op cases). The
  `no-provider-imports` fitness test's banned-import list now includes `@octokit`/`octokit` to
  keep Orchestrator Core provider-SDK-free going forward.

**Deviations from the original plan:**

- Per-handler unit tests (à la a hypothetical `record-pr-opened.test.ts`) were not added — no
  Phase 2/6 command handler has one either (`record-code-pushed.ts`, `escalate-to-human-required.ts`,
  every `planning`/`clarification` handler); handler behavior is instead covered end-to-end through
  `reconcileGithubState()`'s 8 unit tests plus the `github-race` scenario, consistent with the
  established convention.
- `RecordCiFailedHandler`/`RecordChangesRequestedHandler` do not implement the matrix's
  `record_blocking_finding` / `increment_fix_attempt_count` side effects — `review_findings`
  writes and the fix-attempt-threshold counter are Phase 10 (review/fix loop) scope;
  `feature_runs` has no fix-attempt-count column yet. These handlers perform the state transition
  and the `pull_requests` mirror update only.
- `OctokitGitHubClient.getPullRequest()`'s `conversationsResolved` is hardcoded — GitHub's
  REST API has no direct "conversations resolved" field (only GraphQL exposes
  `reviewThreads.nodes.isResolved`); wiring the GraphQL client is deferred (tracked in
  [issue #36](https://github.com/jhoar/MiniCoder/issues/36)). **Post-implementation review fix:**
  the placeholder was originally hardcoded `true`; a later review round flipped it to a
  conservative fail-closed `false`, since nothing in the codebase gates a decision on this field
  yet and treating "unknown" as "resolved" is the more dangerous default for a future merge-gate
  consumer to inherit accidentally. An architectural fitness test
  (`packages/core/src/fitness/no-conversations-resolved-gate.test.ts`) guards against a future
  consumer wiring this field into a real gate without a deliberate, reviewed decision.

## Phase 8 — Execution Orchestrator ✓

> **Status: Complete** (2026-07-02)

Deliver the select-next-feature and start-feature commands, active-feature run records
(`feature_runs`), PR/CI tracking, the Workflow Layer execution flow, feature-progress events,
sequential policy enforcement, pause/resume, and a **minimal budget-gate primitive**: budget
thresholds (`budget_policies`, project/feature/review-cycle scopes), soft/hard limit evaluation, and
the `paused_budget_exceeded` / `waiting_for_budget_approval` transitions (glossary §3.8). Cost
dashboards, forecasting, and export remain Phase 16.

Acceptance: only one feature is active at a time (by policy); eligible features are selected in
sequence; dependencies are enforced; a soft/hard budget breach is evaluated from already-recorded
`cost_records` and pauses automation, recorded through `workflow_events`/`outbox_events` — a fresh
`policy_decision` is written only when a human clears the pause (an approved override or an
operator resume), not by the automatic breach itself (see docs/01 §5.11); mock execution
progresses through the happy path.

**Delivered modules:**

- `packages/core/src/commands/handlers/feature/select-feature.ts`,
  `start-coding.ts`, `record-code-pushed.ts`, and
  `packages/core/src/commands/handlers/automation/pause-automation.ts` — these four handlers were
  fully implemented in Phase 6/7 (idempotency, optimistic locking, `StateTransitionValidator`,
  workflow/outbox events) but never exported from `packages/core/src/index.ts` or called by any
  Trigger.dev task. Phase 8 exports them and gives `select-feature.ts`/`start-coding.ts` a real
  caller (`start-next-feature.ts`, below); `pause-automation.ts` remains reachable for a future
  operator-facing surface (Phase 13's API).
- `packages/core/src/commands/handlers/automation/resume-automation.ts` —
  `ResumeAutomationHandler` (`paused_by_operator → running`, operator actor, records a
  `policy_decisions` row via the new `insertPolicyDecision` helper).
- `packages/core/src/commands/handlers/automation/record-budget-exceeded.ts` —
  `RecordBudgetExceededHandler` (`running → paused_budget_exceeded`, system actor; no
  `policy_decisions` write — the matrix reserves that for the human override, not the breach
  itself).
- `packages/core/src/commands/handlers/automation/record-budget-approval-waiting.ts` —
  `RecordBudgetApprovalWaitingHandler` (`running → waiting_for_budget_approval`, system actor).
- `packages/core/src/commands/handlers/automation/approve-budget-override.ts` —
  `ApproveBudgetOverrideHandler`, serving **both** matrix edges that land on
  `ApproveBudgetOverrideCommand` (`paused_budget_exceeded → running` and
  `waiting_for_budget_approval → running`) from a single handler — the
  `StateTransitionValidator` resolves the correct matrix row from `(fromState, commandName)`.
  Writes a `policy_decisions` row and emits **two** `workflow_events`
  (`automation.budget_override_approved` and `automation.resumed`), matching the matrix's two
  declared `emittedEvents` — the first multi-event handler in the codebase. Callers must select
  the idempotency-key template matching the origin state they observed
  (`budget-override:{projectId}:{expectedVersion}` vs
  `budget-override-waiting:{projectId}:{expectedVersion}`), documented on the handler as the one
  command in the codebase without a single fixed template.
- `packages/core/src/commands/handlers/feature/start-fixing.ts` — `StartFixingHandler`
  (`changes_requested → fixing`, lock-fence-gated like `StartCodingHandler`). Built and exported,
  but intentionally has **no caller in Phase 8** — the review/fix loop that decides when a
  feature re-enters fixing is Phase 10 scope.
- `packages/core/src/commands/handlers/feature/unblock-feature.ts` — `UnblockFeatureHandler`
  (`blocked → approved_pending_execution`, reusing `SelectFeatureHandler`'s unmet-dependency
  guard query). Built and exported; also has no caller yet — nothing in Phase 8 ever transitions
  a feature run to `blocked` in the first place.
- `packages/core/src/commands/handlers/feature/find-next-eligible-feature.ts` —
  `findNextEligibleFeatureRun(db, projectId)`, a plain read function (not a `CommandHandler`)
  that picks the next `approved_pending_execution` feature run whose `feature_dependencies` are
  all `merged`, ordered by `feature_requests.created_at ASC, id ASC` for deterministic
  sequencing. It is a candidate-picker only — `SelectFeatureHandler` remains the sole transition
  authority and re-checks the dependency guard itself, so a stale candidate is simply rejected.
- `packages/core/src/commands/helpers.ts` — new `insertPolicyDecision(tx, {...})`, writing to
  `policy_decisions`; used by `ResumeAutomationHandler` and `ApproveBudgetOverrideHandler`.
- `packages/core/src/cost/` (new directory) — Phase 8's minimal Cost Manager (docs/01 §5.11:
  threshold evaluation only, forecasting/dashboards are Phase 16):
  `budget-evaluator.ts` (`evaluateBudget(db, { projectId, featureRequestId?, scope })` — reads
  the active `budget_policies` row for the scope, sums `cost_records.amount` live respecting
  `window_days`, and returns `ok` / `soft_breach` / `hard_breach`, hard checked before soft; no
  denormalized running-total column) and `apply-budget-decision.ts`
  (`applyBudgetDecision(db, evaluation, {...})` — dispatches `RecordBudgetExceededCommand` or
  `RecordBudgetApprovalWaitingCommand` via `TransactionalCommandExecutor` on a breach, no-ops on
  `ok`; kept separate from the handlers so they stay pure state-transition logic). Both exported
  from `packages/core/src/index.ts`. `budget-evaluator.test.ts` is a genuine per-file unit test
  (a pure function over rows, not a state transition) — an intentional exception to the
  no-per-handler-test convention below.
- `packages/triggerdev/src/tasks/start-next-feature.ts` — real `runImpl`: resolves
  `payload.featureRunId` or calls `findNextEligibleFeatureRun`; pre-checks
  `workflow_states.automation_state`; dispatches `SelectFeatureCommand` (operator actor) then, in
  the same task invocation, acquires the project's `ExecutionLane` and dispatches
  `StartCodingCommand` (system actor), releasing the lane lock in a `finally`. One task, two
  commands — `selected → coding` has no human/webhook gate between them, unlike the genuinely
  event-driven `pr_opened → ci_running`. Expected races (`feature-already-active`,
  `automation-paused`, `unmet-dependencies`, `not-found`) are caught and reported as
  `{ started: false }` rather than thrown, matching `github-reconciliation.ts`'s treatment of
  per-candidate failures as non-fatal.
- `packages/triggerdev/src/tasks/actor.ts` — new `automationOperatorActor(correlationId)`,
  a fixed "automation operator" human identity used for `SelectFeatureCommand` (which requires an
  operator/human actor per its matrix row) since `start-next-feature` has no real authenticated
  session to attribute the run to. Documented as a known Phase 13 placeholder, consistent with
  `ActorPayload`'s existing doc comment; `StartCodingCommand` continues to use the existing
  `systemActor()` (it requires a system actor per its matrix row).
- **Two-mechanism sequential-enforcement story, now wired end to end but unchanged in design:**
  `workflow_states.active_feature_run_id`'s conditional `UPDATE` inside `SelectFeatureHandler`
  (a durable, crash-surviving compare-and-swap — the single-active-feature-per-project invariant)
  and `packages/workflow`'s `ExecutionLane` fence-token lock (a short-lived, heartbeat-able
  mutual-exclusion guard for handlers mutating an already-selected `feature_runs` row). Both
  already existed from Phase 6/7; Phase 8's only change was making `start-next-feature.ts`
  actually acquire the lane lock around `StartCodingCommand`.
- `packages/testing/src/scenarios/execution-orchestrator.ts` +
  `packages/testing/src/fixtures/execution-orchestrator.ts` — new scenario covering the full
  acceptance path: dependency-ordered selection (`start-next-feature` skips a
  dependency-blocked feature and picks the eligible one), single-active-feature enforcement (a
  second `start-next-feature` call while one is active is a clean no-op), the budget gate (a
  soft breach reaches `waiting_for_budget_approval`, an approver override returns to `running`, a
  _second_ soft breach against the same policy correctly reaches `waiting_for_budget_approval`
  again rather than being suppressed by a stale cached idempotency result, a subsequent hard
  breach reaches `paused_budget_exceeded`, and all three overrides are recorded in
  `policy_decisions`), and sequencing continuation (once the first feature is simulated as
  `merged`, the second, previously-blocked feature is selected next). Registered in
  `packages/testing/src/scenarios/index.ts` and `packages/testing/src/fixtures/index.ts`.
- `packages/triggerdev/src/triggerdev.test.ts` — the previously trivial `start-next-feature`
  stub-shape test is now split into a no-candidate-no-op assertion plus a new "start-next-feature
  real wiring" describe block (select-and-start-coding, single-active-feature enforcement, and a
  paused-automation no-op that leaves state untouched).

**Post-implementation review fixes (round 1):**

- **HIGH-1 (idempotency-key collision on repeated budget breaches).** `applyBudgetDecision()`
  originally built `RecordBudgetExceededCommand`/`RecordBudgetApprovalWaitingCommand` idempotency
  keys from `projectId` alone (`budget-exceeded:{projectId}`). A project can legitimately breach
  the same threshold, get overridden back to `running`, and breach again — each such occurrence is
  read against a distinct `workflow_states.version`, but the original key was identical every
  time, so `TransactionalCommandExecutor` returned the _first_ breach's cached result for every
  later one within the 7-day idempotency TTL, silently leaving automation `running` through a
  second breach. Fixed by including `{policyId}:{expectedVersion}` in the key
  (`packages/core/src/cost/apply-budget-decision.ts`); `ApproveBudgetOverrideCommand`'s
  caller-supplied keys (documented on the handler and used by the scenario/CLI) gained the same
  `:{expectedVersion}` suffix for the identical reason. `AUTOMATION_CONTROL_MATRIX`'s
  `idempotencyKeyTemplate` fields for all three commands were updated to match. The
  `execution-orchestrator` scenario's step 4b (a second soft breach after the first override) is
  the regression test for this fix.
- **MEDIUM-2 (docs/implementation mismatch on `policy_decisions`).** docs/01 §5.11 previously said
  "every enforcement decision is recorded as a `policy_decision`," but `RecordBudgetExceededHandler`/
  `RecordBudgetApprovalWaitingHandler` deliberately do not write one (only the human
  override/resume does). The spec was corrected to describe the actual, intentional split: a
  breach is captured via `workflow_events`/`outbox_events`, and `policy_decisions` is reserved for
  the audit trail of a human's judgment call.
- **MEDIUM-3 (nondeterministic active-policy selection).** `evaluateBudget()` selected an active
  `budget_policies` row via `.find()` over an unordered query result; nothing prevents more than
  one active row from matching the same `(project, scope, feature)` tuple. Fixed by adding
  `ORDER BY updated_at DESC, id DESC` to the query, the same "most recent wins" tiebreaker
  `AdapterRegistry.getConfiguration()` already uses for an analogous ambiguity.
- **LOW-1 (misleading comment).** `automationOperatorActor()`'s doc comment incorrectly implied
  `StartCodingCommand` also uses the placeholder human actor; corrected to state only
  `SelectFeatureCommand` does (`StartCodingCommand` uses `systemActor()`, matching its own matrix
  row).

**Post-implementation review fixes (round 2):**

- **HIGH-1 (automation control bypassable between feature selection and coding start).**
  `start-next-feature.ts` checked `workflow_states.automation_state = 'running'` once, then
  dispatched `SelectFeatureCommand`, then later acquired the execution lane and dispatched
  `StartCodingCommand` — but `StartCodingHandler` itself never re-checked `automation_state`, only
  the active-feature-run pointer and lock fence. A pause or budget breach landing in the window
  between selection and coding start (an operator pause, a hard/soft budget breach from a
  different code path) could not stop coding from starting. Fixed by making
  `StartCodingHandler`'s `feature_runs` UPDATE atomically re-check
  `EXISTS (SELECT 1 FROM workflow_states WHERE project_id = ? AND automation_state = 'running')`
  in the same statement, throwing the same `automation-paused` `CommandError` type
  `SelectFeatureHandler` already uses (which `start-next-feature.ts`'s `isTransientRace()` already
  treats as a non-fatal, expected race) when the check fails; `StartFixingHandler` — the only
  other handler that starts new automated work rather than recording an already-in-flight
  action's outcome — got the identical guard while it was already being touched for the
  MEDIUM-1 fix below. New tests in
  `packages/testing/src/automation-control-race.test.ts` drive
  select → pause → start-coding (operator pause) and select → hard-breach → start-coding (budget
  pause) and assert both are rejected with the feature run left at `selected`.
- **MEDIUM-1 (occurrence-insensitive idempotency keys on other repeatable transitions).**
  `pause-automation:{projectId}`, `resume-automation:{projectId}`, and
  `start-fixing:{featureRunId}` had the same class of bug the first review round fixed for budget
  breaches/overrides: a project can be paused/resumed, or a feature can cycle
  `changes_requested → fixing`, more than once over its lifetime, and an occurrence-insensitive
  key lets `TransactionalCommandExecutor` replay a stale cached result instead of executing.
  `AUTOMATION_CONTROL_MATRIX`/`FEATURE_EXECUTION_MATRIX`'s `idempotencyKeyTemplate` fields and the
  handlers' doc comments were updated to require `{expectedVersion}` (documenting the caller
  contract, since — like `ApproveBudgetOverrideCommand` — none of these three commands has a real
  caller yet that the fix needed to touch beyond the new test file).
  `packages/testing/src/automation-control-race.test.ts` covers pause→resume→pause,
  pause→resume→pause→resume, two `changes_requested → fixing` cycles, and a second budget
  override, asserting each repeated occurrence actually transitions rather than replaying a
  cached result.
- **MEDIUM-2 (stale runbook idempotency-key examples).** The Phase 8 runbook in docs/04 §11 still
  showed `budget-override:{projectId}`/`budget-override-waiting:{projectId}` (pre-HIGH-1-fix
  form) as the keys an operator should use for manual recovery — following it would have
  recreated the exact collision the first review round fixed. Updated to include
  `{expectedVersion}`, plus `resume-automation:{projectId}:{expectedVersion}` for the
  operator-pause case.
- **MEDIUM-3 (implementation plan still described the pre-fix audit contract).** This Phase 8
  section's acceptance text said a budget breach "records a `policy_decision`/`cost_record`,"
  contradicting the round-1 MEDIUM-2 fix (breaches are evaluated from already-existing
  `cost_records` and recorded via `workflow_events`/`outbox_events`; `policy_decisions` is
  reserved for the human override/resume decision). Reworded to match.

**Post-implementation review fixes (round 3):**

- **HIGH-1 (a stranded 'selected' feature run could outlive its pause/budget-pause).** The round-2
  HIGH-1 fix correctly made `StartCodingHandler` reject coding when automation isn't `running`,
  but `start-next-feature.ts` had no way to find that feature run again afterward:
  `findNextEligibleFeatureRun()` only searches for `approved_pending_execution` rows, and
  `workflow_states.active_feature_run_id` still points at the stranded `selected` run (blocking
  `SelectFeatureHandler`'s compare-and-swap from picking anything else). A transient pause could
  therefore strand a project indefinitely, even after automation resumed, until an operator
  manually intervened. Fixed by having `start-next-feature.ts` check
  `workflow_states.active_feature_run_id` first when no `featureRunId` is supplied: if it points
  at a feature run still at `selected`, the task skips `SelectFeatureCommand` entirely and
  dispatches `StartCodingCommand` directly for that run. New parameterized tests in
  `packages/triggerdev/src/triggerdev.test.ts` (`paused_by_operator`, `paused_budget_exceeded`,
  `waiting_for_budget_approval`) drive select → pause/budget-pause → resume → scheduled
  `start-next-feature` and assert the stranded run reaches `coding` (verified by temporarily
  reverting the fix and confirming all three fail without it).
- **MEDIUM-1 (one more stale key example).** The `ApproveBudgetOverrideHandler` "Delivered
  modules" bullet in this Phase 8 section still showed the pre-fix
  `budget-override:{projectId}` / `budget-override-waiting:{projectId}` forms even after the
  round-2 MEDIUM-2 fix updated the docs/04 runbook. Updated to include `{expectedVersion}`. A
  repo-wide grep sweep (per CLAUDE.md's documentation editing guidelines) confirmed no other
  stale unversioned key template remains outside the "Post-implementation review fixes" narrative
  sections that intentionally quote the old, buggy forms while describing past bugs.

**Post-implementation review fixes (round 4 — comprehensive `start-next-feature.ts` hardening):**

- **HIGH-1 (a concurrent execution-lane holder caused a spurious task failure).** A comprehensive
  pass over `start-next-feature.ts` (after three rounds each surfaced a new bug in the
  select → code handoff) found that `ExecutionLane.acquireForProject()` — which throws
  `LockConflictError` when another actor holds `execution-lane:{projectId}` — was called
  **outside** the task's `try` block, so a lost acquire propagated as an uncaught task failure.
  That lock is genuinely contended: `github-reconciliation.ts` acquires the same lock for its
  lock-gated reconciliation commands, and HA-cluster peers / overlapping retries add more
  contenders. So a routine concurrency condition surfaced as a failed Trigger.dev run
  (retried 3× with backoff, then a hard failure) — directly contradicting the file's own stated
  design ("expected race … reported as `started: false`, not thrown"). Fixed by wrapping the lane
  acquire in its own `try` and introducing an `isTransientRace()` classifier that returns
  `started: false` for `LockConflictError`, `OptimisticLockError` (a concurrent writer bumped
  `feature_runs.version` between this task's fresh read and a command's CAS), `StaleFenceError`
  (the lane lease reclaimed mid-op), and the expected `CommandError` types — now including
  `concurrent-command` (two invocations racing on the same idempotency key in-flight), which was
  previously also uncaught. A genuine infrastructure failure matches none of these and still
  throws. A deterministic regression test in `packages/triggerdev/src/triggerdev.test.ts`
  pre-acquires the lane with a foreign holder, asserts `start-next-feature` returns
  `started: false` with the run parked at `selected`, then releases the lock and confirms the
  next tick recovers it to `coding` via the round-3 stranded-selected path (verified by
  temporarily restoring the acquire-outside-`try` structure and confirming the test fails).
- **Non-issues confirmed during the pass** (documented to preempt future churn): the
  `select-feature:{featureRunId}` / `start-coding:{featureRunId}` idempotency keys are correctly
  **not** `{expectedVersion}`-scoped — a `feature_runs` row is a single attempt that transitions
  `→selected`/`→coding` at most once, so the run id is already occurrence-unique (unlike the
  recurring project-scoped automation-control keys), and a failed attempt rolls back its claim
  inside the handler transaction. `findNextEligibleFeatureRun()` not checking
  `active_feature_run_id` is the intended loose-candidate-picker design (`SelectFeatureHandler`
  is the guard, rejecting with the already-handled `feature-already-active`). A brief code comment
  now records both, so a future reviewer does not re-flag them.

**Post-implementation review fixes (round 5 — same lane-contention hardening for `github-reconciliation.ts`):**

- **HIGH-1 (a contended execution lane aborted the whole reconciliation batch).** The round-4
  `start-next-feature.ts` fix left its sibling `github-reconciliation.ts` with the identical
  uncaught-`LockConflictError` shape: its per-candidate loop calls `lockManager.acquire()` on the
  same `execution-lane:{projectId}` lock (via `reconcileWithLock`) with no catch, so a concurrent
  holder — the `start-next-feature` task, a webhook-triggered inbox handler, or an HA-cluster peer
  — threw an uncaught `LockConflictError` that aborted reconciliation of every _other_ candidate
  in the batch and failed the task. Fixed by adding the same `isTransientRace()` classifier
  (`LockConflictError` / `OptimisticLockError` / `StaleFenceError` / `concurrent-command`
  `CommandError`) and wrapping each candidate's `reconcileGithubState`/`reconcileWithLock` calls
  in a `try` that **`continue`s to the next candidate** on a transient race rather than returning
  from the whole task (the per-candidate analogue of `start-next-feature`'s `started: false`) —
  the held candidate is reconciled by a later scheduled pass. The wrapping `try` deliberately does
  **not** cover the `GitHubClient.getPullRequest` fetch, so a genuine GitHub API/DB failure still
  throws and fails the task for Trigger.dev retry. A deterministic regression test in
  `packages/triggerdev/src/tasks/github-reconciliation.test.ts` pre-acquires the lane with a
  foreign holder, asserts the task returns cleanly (`reconciled: 0`, candidate untouched at
  `code_pushed`), then releases the lane and confirms a subsequent pass reconciles it to
  `pr_opened` (verified by restoring the uncaught structure and confirming the test fails).

**Post-implementation review fixes (round 6):**

- **HIGH-1 (explicit `featureRunId` retry could still fail a stranded selected run).** The
  round-3 stranded-selected recovery in `start-next-feature.ts` only ran when
  `payload.featureRunId` was omitted (the scheduled/auto-discovery path). A caller explicitly
  naming the project's already-selected active run directly — e.g. a targeted retry after a
  prior partial failure, or a manual re-invocation — still fell through to dispatching
  `SelectFeatureCommand`, which is an invalid `selected -> selected` transition:
  `StateTransitionValidator.assertValid` throws a plain `TransitionError` (not a `CommandError`),
  which `isTransientRace()` does not catch, so it propagated as an uncaught task failure instead
  of recovering and starting coding. Fixed by running the same active-run/`selected`-state check
  for both the explicit and auto-discovery `featureRunId` paths (a single
  `workflow_states.active_feature_run_id` read, followed by a `feature_runs.current_execution_state`
  check when the resolved `featureRunId` — whichever path supplied it — matches that active run).
  New test in `packages/triggerdev/src/triggerdev.test.ts` seeds a stranded `selected` run and
  calls `start-next-feature` with that run's id passed explicitly, asserting it recovers and
  reaches `coding` (verified by reverting to the omitted-only check and confirming the test fails
  with `TransitionError: selected -> selected`).
- **LOW-1 (stale `isExpectedRace()` references).** `CLAUDE.md` and this section referred to the
  classifier by its pre-round-4 name; both now say `isTransientRace()`, matching the code.

**Deviations from the original plan:**

- No new migration was needed — `feature_runs`, `workflow_states`, `budget_policies`,
  `cost_records`, and `policy_decisions` all already existed in migration `0001` with every
  column Phase 8 required. `feature_requests` already carries `idx_feature_requests_project_id`
  and `idx_feature_requests_state`, adequate at Phase 8 data volumes, so no ordering index was
  added either.
- `start-fixing.ts` and `unblock-feature.ts` are built and exported but intentionally have no
  caller in Phase 8 (see above) — the same "handler exists, caller lands later" posture Phase 7
  left `StartCodingHandler`/`RecordCodePushedHandler` in before this phase gave them one.
- Per-handler unit tests were not added, consistent with the precedent set in Phase 7 ("Deviations
  from the original plan" there notes no Phase 2/6/7 command handler has one); coverage comes from
  the `execution-orchestrator` scenario and the `triggerdev.test.ts` wiring tests instead. The one
  exception is `budget-evaluator.test.ts`, which is a pure function over rows (not a
  state-machine transition) and genuinely fits unit testing the way handlers do not.
- `RecordApprovedByPolicyCommand`, `MergeIfReadyCommand`, `RecordMergedCommand`,
  `RecordMergeFailedCommand`, `ReconcileMergeFailedCommand` (Phase 12 — Merge Gate) and
  `RequestChangesAfterCiFailCommand` and fix-attempt counting (Phase 10 — Review/Fix Loop; no
  fix-attempt-count column exists on `feature_runs` yet) remain unbuilt, as scoped. The
  scenario's "sequencing continuation" step simulates a feature reaching `merged` with a direct
  SQL update rather than a real merge command, standing in for the not-yet-built Phase 12 path.

## Phase 9 — Reference Coder Adapter ✓

> **Status: Complete** (2026-07-04)

Delivers a reference Coder adapter (`CodexCoderAdapter`), coder context packs, branch-update
handling, commit/push tracking, coder-run cost/token records, and — for the first time — a real
(not merely documented) implementation of the workspace-sandboxing policy in
[`07-security-and-secrets.md`](07-security-and-secrets.md) §6. This is where the pipeline built in
Phases 1–8 stops being purely structural: before this phase, nothing after `StartCodingCommand` did
any real work — `feature_runs` reached `coding` and no adapter was ever invoked in production.
Phase 5 deferred provider-level fields, cost/token reporting, and Workflow Layer wrapper invocation
of adapters to "Phase 9+" (see Phase 5's "Deferred to Phase 9–10" note above) — this is that phase.

**Scope decisions:**

1. **LLM codegen goes through a small injected interface, not a vendor SDK.** `CodexCoderAdapter`
   takes a `CodeGenerationProvider` (`generate({featureTitle, acceptanceCriteria, repoContext}) →
{files, tokensUsed?}`) via constructor injection. Ships exactly one concrete implementation,
   `HttpCodeGenerationProvider` — a plain `fetch`-based client against an OpenAI-compatible
   chat/completions endpoint (configurable base URL/API key/model), no vendor SDK dependency. Tests
   use a deterministic fake implementation of the interface.
2. **Real sandboxing ships in this phase, not deferred.** Container-level isolation with network
   egress denial is in scope now (not pushed to Phase 16/18) — this materially increased the
   phase's size versus a typical phase.
3. **Code push uses local git, not a Git Data API.** The adapter package owns its own git
   clone/commit/push (via `child_process.execFile`, token-authenticated HTTPS remote, never
   `--force`) rather than `GitHubClient` growing `createBlob`/`createTree`/`createCommit` methods.
   `GitHubClient`'s interface did not change; the only new production behavior is a new call site
   for the already-existing (previously uncalled) `createPullRequest`.

**Delivered modules:**

- `packages/adapters-coder/` (new package, `@minicoder/adapters-coder`) — depends only on
  `@minicoder/core`'s adapter role types (`CoderAgentAdapter`, `CoderInput`, `CoderOutput`) and
  error taxonomy (`AdapterRunError`, `AgentRunErrorType`), never core's command/persistence
  internals: `codex-coder-adapter.ts` (`CodexCoderAdapter`, composing the modules below into a
  `CoderAgentAdapter`), `sandbox.ts` (`CoderSandbox`, a `dockerode`-based ephemeral container
  lifecycle implementing a shared `CommandRunner` seam), `workspace.ts` (git clone/checkout/write/
  commit/push orchestration, runner-agnostic so the same code runs against a local
  `child_process` runner in tests or inside a sandbox container via `docker exec` in production),
  `command-runner.ts` (`ChildProcessCommandRunner`, the local-execution seam), `diff-guard.ts`
  (bounded-diff/disallowed-path checks — a pure function, defense-in-depth on top of container
  isolation, not a replacement for it), `code-generation-provider.ts` (`CodeGenerationProvider`
  interface + `HttpCodeGenerationProvider`), `context-pack.ts` (`ContextPackV1`, a versioned Zod
  schema per docs/03 §11.4).
- `packages/migrations/migrations/0010_agent_run_provider_tracking.*` — adds `provider`, `model`,
  `prompt_template_version` to `agent_runs` (additive only; `EXPECTED_TABLES` count is unchanged —
  no new table). No `agent_runs.triggerdev_run_id` column — `triggerdev_runs.linked_agent_run_id`
  already provides that join; a second redundant join column was considered and rejected. No new
  `input_artifact_references`/`output_artifact_references` columns — input maps onto the new
  `agent_context_packs` row id, output stays in the existing `output_summary` JSON. `cost_records`
  needed no new columns.
- `packages/core/src/adapters/run-recorder.ts` — `AgentRunRecorder`/`RecordRunOptions` gain
  additive, backward-compatible fields: `contextPack` (writes one `agent_context_packs` row before
  the wrapped call runs — Phase 9 is this table's first production writer), `costExtractor` (a
  function of the run's `RunOutcome` — success _or_ failure, since a failed provider call can
  still carry partial usage — that folds `tokens_used`/`cost_usd`/`provider`/`model` into the
  existing `agent_runs` UPDATE and writes one `cost_records` row, `scope='feature'` when
  `featureRequestId` is supplied else `'project'`, **before** any budget evaluation the caller
  performs next — write-then-evaluate ordering per docs/01 §5.11 and this document's Budget Gate
  section; throws if a reported `costUsd` has no `projectId` to attribute it to, since
  `cost_records.project_id` is `NOT NULL`), and `toolOperationsExtractor` (writes
  `agent_tool_operations` rows — Phase 9 is also this table's first production writer). Existing
  Phase 5/6 callers are unaffected — all three fields are optional.
- `packages/core/src/commands/handlers/feature/record-code-pushed.ts` — `RecordCodePushedCommand`'s
  payload gains `branchName` and `filesChanged` (previously only `commitSha`), carried into the
  `feature.code_pushed` `workflow_events`/`outbox_events` payload (`packages/core/src/events/
schemas.ts`'s `FeatureCodePushedPayloadSchema` extended to match); no new `feature_runs` column
  was needed. The command's idempotency key stays `record-code-pushed:{featureRunId}:{commitSha}`
  unchanged — `commitSha` is already a per-occurrence discriminator (a genuinely new commit per
  push), so it already satisfies this document's `{expectedVersion}`-or-equivalent convention;
  changing it was considered and correctly not done.
- `packages/triggerdev/src/tasks/run-coder.ts` (new task) — bridges `coding` → sandboxed adapter
  invocation → `RecordCodePushedCommand` → PR creation. A **separate**, independently
  scheduled/triggered task from `start-next-feature.ts` (not inlined into it) — matching the
  existing event-driven `pr_opened → ci_running` pattern rather than growing
  `start-next-feature.ts`'s already six-rounds-of-review-hardened logic. Resolves the active
  `CoderAgentAdapter` DB record via `AdapterRegistry` (never imports `CodexCoderAdapter` directly —
  the literal "orchestrator does not call provider APIs directly" acceptance criterion) while a
  separate, caller-injected `CoderAdapterFactory` (`(repoUrl) => Promise<CoderAgentAdapter>`)
  supplies the actual runtime instance — a factory, not a singleton, since one deployment can serve
  multiple projects with different repos and `CoderInput` itself carries no repo/credential
  fields. Invokes the adapter through the extended `AgentRunRecorder`, acquires
  `execution-lane:{projectId}` to dispatch `RecordCodePushedCommand`, then calls
  `GitHubClient.createPullRequest` outside the lock (a non-fatal, logged side effect if it fails —
  the coder's work is already durably recorded; reconciliation or a human can retry PR creation).
  On adapter failure, the feature run is left at `coding` with no new `coding → failed/blocked`
  matrix edge — that escalation loop is Phase 10/11 scope, the same "handler exists, caller lands
  later" posture Phase 8 used for `StartFixingHandler`/`UnblockFeatureHandler`. Its default
  resolvers (`resolveDefaultCoderAdapterFactory`/`resolveDefaultGithubClientFactory`) construct a
  real `CodexCoderAdapter`/`OctokitGitHubClient` from env vars via dynamic `import()` (mirroring
  `github-reconciliation.ts`'s existing pattern for `GitHubClient`), failing fast with an
  actionable error if `GITHUB_TOKEN`/`CODE_GEN_BASE_URL`/`CODE_GEN_API_KEY`/`CODE_GEN_MODEL` are
  unset; test scenarios inject `MockCoderAdapter`/`MockGitHubClient` directly instead.
- `packages/triggerdev/src/tasks/transient-race.ts` (new) — `isTransientRace(err,
expectedCommandErrorTypes)` extracted from `start-next-feature.ts`'s previously-duplicated
  private copy; `github-reconciliation.ts` and the new `run-coder.ts` now share this one
  implementation of the `LockConflictError`/`OptimisticLockError`/`StaleFenceError` classification,
  each still supplying its own task-specific `CommandError` `problem.type` allow-list.
- `packages/testing/src/services/mock-github-client.ts` — `MockGitHubClient.createBranch`/
  `createPullRequest` changed from throwing stubs ("not used by Phase 7 scenarios") to real
  deterministic in-memory recorders (`branches`/`pullRequests` arrays); `createPullRequest` also
  registers the PR into the wrapped `MockGitHubProvider` (deriving the feature-run id from the
  `minicoder/<featureRunId>` branch-naming convention) so `getPullRequest`/`reconcileGithubState`
  observe it exactly as they would a real GitHub PR.
- `packages/testing/src/scenarios/coder-adapter-run.ts` + `fixtures/coder-adapter-run.ts` (new
  scenario, registered alongside `execution-orchestrator`, runnable via `minicoder test system`) —
  drives two feature runs already fixture-seeded at `coding`: one through `run-coder` to
  `code_pushed` with `MockCoderAdapter('success')`/the upgraded `MockGitHubClient`, asserting on
  `agent_runs` (`succeeded`), exactly one `agent_context_packs` row, and the resulting
  `createPullRequest` call; the other with `MockCoderAdapter('fail')`, asserting the feature run
  stays at `coding` with exactly one `agent_errors` row rather than a false `code_pushed`
  transition. Registers `MockCoderAdapter` into the DB-backed `AdapterRegistry` itself (scoped to
  this scenario, since it is the first to need a `CoderAgentAdapter` registry entry) rather than
  extending `runner.ts`'s shared setup.
- `infra/docker-compose.coder-sandbox.yml` + `infra/docker/coder-sandbox/{Dockerfile,egress-proxy/}`
  (new) — a 2-service stack (`coder-sandbox-egress-proxy`: a `tinyproxy` allow-list forward proxy,
  `FilterDefaultDeny yes`, dual-homed between an `internal: true` sandbox network and a real-egress
  network, GitHub-hosts baked in plus the configured LLM host appended at container start;
  `coder-sandbox-docker-proxy`: a narrowly-scoped second `tecnativa/docker-socket-proxy` instance,
  separate from the Trigger.dev supervisor's own proxy) following `docker-compose.triggerdev.yml`'s
  established conventions (named isolated networks, per-service resource limits). The pre-baked
  sandbox image (non-root user, git + Node/pnpm preinstalled) is built separately and referenced by
  name, since `CoderSandbox` creates/removes one container per run rather than running one
  persistent service.

**Test coverage delivered:** `packages/adapters-coder`'s unit suite (`diff-guard.test.ts`,
`sandbox.test.ts` against a fake `dockerode` client, `workspace.test.ts` against a real local
throwaway git repo — no Docker required, `codex-coder-adapter.test.ts` against a fake `Sandbox` +
fake `CodeGenerationProvider`); `run-recorder.test.ts`'s new "context packs, cost/tool-operation
provenance" describe block in `packages/core`; `packages/triggerdev/src/tasks/run-coder.test.ts`
(no-op-off-coding, happy path with full provenance assertions, PR-creation-failure-is-non-fatal,
adapter-failure-leaves-`coding`); the `coder-adapter-run` scenario described above.

**Deviations from the original plan:**

- **No Docker-daemon-gated integration test was added.** The implementation session's environment
  had no reachable Docker daemon (`docker info` failed), so the sandbox infra
  (`infra/docker-compose.coder-sandbox.yml`, the Dockerfiles) could be written and syntax-validated
  (`docker compose config`) but not exercised end to end, and no gated test proving egress denial
  was added. This is tracked as follow-up work for an environment with a live daemon, the same way
  a `MINICODER_TEST_PG_URL`-gated test requires a reachable PostgreSQL instance.
- The scenario drives `coding → code_pushed` directly (both fixture feature runs start at
  `coding`) rather than the full `selected → coding → code_pushed` path — `start-next-feature`'s
  `selected → coding` transition is already covered by the `execution-orchestrator` scenario, so
  re-covering it here would be redundant; `coder-adapter-run` is scoped to what's new in this
  phase.
- `RecordCodePushedCommand`'s idempotency key was **not** changed to include `{expectedVersion}` —
  see "Delivered modules" above; `commitSha` was already occurrence-unique.

**Post-implementation review fixes (round 1):** a full code/architecture/security review found
one Critical, six High, three Medium, and one Low finding, all fixed. Highlights: the
`feature.code_pushed` event schema required `.uuid()` IDs but `generateId()` never produces one
(a pre-existing, pre-Phase-7 latent bug newly exposed by this phase's schema extension); the
sandbox's `/workspace` mount was missing entirely under `ReadonlyRootfs`, so every real run would
have failed at clone time; commits had no git author identity configured; generated file paths
were written before the diff guard's disallowed-path check ever ran, so `../`/absolute-path
traversal could escape the intended tree; the GitHub token could leak through failed-git-command
error messages; coder runs never actually wrote a `cost_records` row (no `costUsd`, only token
counts), undermining the budget-gate integration claim; PR creation was hardcoded to `main`
instead of using `repositories.default_branch`; and `prompt_template_version` was declared but
never persisted. See CLAUDE.md's Reference Coder Adapter Operational Constraints section for the
full fix-by-fix writeup and regression-test pointers.

**Post-implementation review fixes (round 2):** a re-review found round 1's `feature.code_pushed`
schema fix was incomplete — the identical `.uuid()`-vs-`generateId()` mismatch was still live on
every other event schema in the same file (`feature.selected`, `feature.coding_started`,
`feature.merged`, `plan.approved`, `plan.activated`, `automation.paused_by_operator`/
`.budget_exceeded`, `automation.resumed`) — fixed everywhere in one pass, with a new
schema-level regression test file. Also fixed: `prompt_template_version` still wasn't populated
for real coder runs (only synthetic/test calls); cost-pricing env vars were parsed without
validation (a malformed value could silently poison a persisted cost); and a stale runbook example
still omitted the now-required `coderAdapterName`. Also clarified (docs-only, no code change) that
the code-generation LLM call is deliberately host-process, not routed through the sandbox's egress
proxy — the sandbox is the untrusted-code-execution boundary, so the LLM credential must stay out
of it. See CLAUDE.md's Reference Coder Adapter Operational Constraints "round 2" section for detail.

**Post-implementation review fixes (round 3):** a third re-review found `PlanActivatedPayloadSchema`
required `featureRequestCount`, a field the real producer (`ActivatePlanHandler`) never emits — it
emits `activatedFeatureCount` — so every real `plan.activated` event still failed validation
despite round 2's schema-level test suite, which had hand-built its payload using the schema's own
(wrong) field name instead of checking the actual producer. Fixed by renaming the schema field and
adding a producer-level regression test (`backlog-activation` scenario now parses the real emitted
outbox row against `EVENT_SCHEMAS`, not a hand-built payload). Also fixed: blank
(empty-string/whitespace) `CODE_GEN_PRICE_PER_1K_*_TOKENS`/`CODER_PROMPT_TEMPLATE_VERSION` env
vars were silently accepted (`Number('')` evaluates to `0` in JavaScript), bypassing round 2's
validation — both now explicitly reject blank values and fall back to the default; and two stale
doc/comment inconsistencies from round 2's trust-boundary decision were corrected. See CLAUDE.md's
Reference Coder Adapter Operational Constraints "round 3" section for detail.

**Post-implementation review fixes (round 4):** a fourth re-review found no critical/high/medium
issues (round 3's fixes held), with two low-priority watch items: required runtime env vars
(`GITHUB_TOKEN`, `CODE_GEN_BASE_URL`, `CODE_GEN_API_KEY`, `CODE_GEN_MODEL`) were still only
truthiness-checked, inconsistent with round 3's blank-rejection treatment of the pricing/
prompt-version env vars — fixed with a shared `requireNonBlankEnvVar()` helper; and the
`plan.activated` producer regression validated payload shape but not count semantics — fixed by
asserting the parsed `activatedFeatureCount` equals the actual number of `feature_runs` rows
produced. See CLAUDE.md's Reference Coder Adapter Operational Constraints "round 4" section for
detail.

**Post-implementation review fixes (round 5):** a fifth re-review found no critical/high/medium
issues, with three low-priority watch items: `github-reconciliation.ts` still used a
truthiness-only `GITHUB_TOKEN` check while `run-coder.ts` had already moved to blank-rejecting
validation, so the two GitHub-facing tasks had diverging contracts for the same env var — fixed
by extracting the shared `requireNonBlankEnvVar()` helper into a new `tasks/env.ts`, adopted by
both; the `plan.activated` count regression only held because the fixture never had a
preexisting `feature_runs` row (`activatedFeatureCount` means "newly inserted," not "final
total," and a regression reporting the total would still have passed) — fixed by seeding a
preexisting row and asserting the delta; and a suggested observability/alerting item for
pushed-but-no-PR runs was explicitly deferred as genuine future work (Phase 16 observability
scope), not built now. See CLAUDE.md's Reference Coder Adapter Operational Constraints "round 5"
section for detail.

Acceptance: the adapter implements `CoderAgentAdapter`; the orchestrator does not call provider APIs
directly (adapter resolution is always via `AdapterRegistry`); a coder run executes inside an
isolated, egress-restricted, ephemeral container (infra written; not yet daemon-verified — see
Deviations) and can update a branch; changed files/commits are recorded on both `feature_runs` (via
the extended `RecordCodePushedCommand`) and `agent_runs`/`agent_context_packs`/
`agent_tool_operations`; coder-run cost/token usage is recorded in `cost_records` before any budget
evaluation runs against it; a PR is opened via the (previously uncalled)
`GitHubClient.createPullRequest`.

**Explicitly deferred to later phases:** per-`AgentRun` pre-flight token/cost forecast-before-call
(Phase 16, already marked there in docs/01 §5.11); the review/fix loop and any `coding`/
`code_pushed → changes_requested/fixing` re-entry (Phase 10); disagreement/arbiter handling of
coder-vs-reviewer conflicts (Phase 11); merge-gate consumption of this phase's cost/PR data
(Phase 12); multiple concurrent coder runs per project / parallel sandboxes (Phase 18); a
production-grade LLM-provider-selection UI or prompt-template-versioning workflow (ongoing/Phase 16
observability). Git Data API methods on `GitHubClient` and an `agent_runs.triggerdev_run_id` column
were both considered and explicitly rejected (see "Delivered modules" above) — do not re-propose
either without new information.

## Phase 10 — Reference Reviewer Adapter and Review/Fix Loop ✓

> **Status: Complete** (2026-07-04)

Delivers a reference Reviewer adapter (`ClaudeReviewerAdapter`), a structured review-finding
parser/normalizer, the `run-review` Workflow Layer task, coder-response records, and a
feature-level fix-attempt counter. This is where everything downstream of `under_review` stops
being dead code: before this phase, the matrix's review/fix-loop rows (`under_review ->
changes_requested`, `changes_requested -> fixing`, `ci_failed -> changes_requested`) were declared
but had no real reviewer-adapter-driven caller, `review_findings`/`coder_responses` had zero
production writers, and `feature_runs` had no fix-attempt-count column at all.

**Scope decisions:**

1. **The Reviewer adapter needs no sandbox — a real simplification versus Phase 9.** Reviewing a
   pull request is read-only (fetch the diff, ask an LLM, return findings); `ClaudeReviewerAdapter`
   calls its injected `ReviewProvider` directly from the `run-review` Trigger.dev task process, with
   no container isolation to manage. `HttpReviewProvider` is the one shipped implementation — a
   plain `fetch`-based OpenAI-compatible client, mirroring `HttpCodeGenerationProvider`'s shape.
2. **Single feature-level `fix_attempt_count` counter, not per-finding/reopening tracking.**
   `FIX_ATTEMPT_THRESHOLD = 5` (`packages/core/src/domain/constants.ts`) is checked everywhere the
   matrix calls for a fix-attempt guard. docs/01 §5.8's finer-grained "two fix attempts per
   finding, one reopening" limits are explicitly deferred, not designed away.
3. **No `RecordApprovedByPolicyCommand` invented.** A clean review (no blocking, no
   `requires_human_decision` findings) writes its (non-blocking) `review_findings` rows and leaves
   the feature run at `under_review` — there is no merge gate yet to block, so "non-blocking
   findings do not block merge" holds trivially until Phase 12 adds a real gate.
4. **One normalization point.** `run-review.ts` always calls `@minicoder/core`'s
   `normalizeReviewerFindings()` on the adapter's raw output, regardless of which adapter produced
   it (`ClaudeReviewerAdapter` or a test `MockReviewerAdapter`) — the adapter itself returns raw,
   unvalidated `ReviewFindingOutput[]`.
5. **`ci_failed` next-transition ownership stays inside `reconcileGithubState()`.** Immediately
   after a `ci_running -> ci_failed` transition, the same bounded catch-up loop dispatches
   `RequestChangesAfterCiFailCommand` (below threshold) or `EscalateToHumanCommand` (at/over) — so
   both the webhook path and the scheduled `github-reconciliation` task get this for free.
6. **The `CODE_GEN_*` env vars are reused for the reviewer LLM backend**, rather than introducing a
   parallel `REVIEW_*` family — the same OpenAI-compatible endpoint can serve both roles by default;
   a deployment wanting a distinct reviewer model can still inject a custom `ReviewerAdapterFactory`.
7. **A pre-existing idempotency-key bug was fixed while touching this matrix row.** `ci_failed ->
changes_requested`'s template lacked a per-occurrence discriminator
   (`changes-requested-after-ci:{featureRunId}`) even though this edge can recur across multiple
   CI-failure cycles for the same feature run — fixed to
   `changes-requested-after-ci:{featureRunId}:{expectedVersion}`.

**Delivered modules:**

- `packages/migrations/migrations/0011_fix_attempt_count.*` — adds `feature_runs.fix_attempt_count
INTEGER NOT NULL DEFAULT 0` (additive only; `EXPECTED_TABLES` count is unchanged — no new table).
- `packages/core/src/adapters/types.ts` — `ReviewFindingOutput.severity` widened to the full
  6-value `FindingSeverity` domain (`out_of_scope`/`requires_human_decision` were missing from the
  adapter contract); `CoderInput` gains an optional `openFindings` field for fix-cycle re-entry.
- `packages/core/src/review/` (new) — `normalize-findings.ts` (`ReviewFindingInsertSchema`,
  `normalizeReviewerFindings()`) and `write-findings.ts` (`insertReviewFindings()`, a non-command
  evidence-data writer with deterministic `review-finding:{featureRunId}:{reviewCycle}:{index}`
  ids and `ON CONFLICT (id) DO NOTHING` for idempotent retry — the same category of writer as
  `agent_context_packs`).
- `packages/core/src/domain/constants.ts` (new) — `FIX_ATTEMPT_THRESHOLD`.
- `packages/core/src/commands/handlers/github/record-changes-requested.ts` — extended with the
  fix-attempt-threshold guard, `increment_fix_attempt_count` side effect, and optional
  `findings`/`reviewerRunId` payload fields (populated by `run-review.ts`, absent for
  `reconcileGithubState()`'s GitHub-human-review caller).
- `packages/core/src/commands/handlers/github/record-ci-failed.ts` — extended to insert one
  blocking `review_findings` row (category `ci_failure`) in the same transaction as the state
  transition — the matrix's `record_blocking_finding` side effect.
- `packages/core/src/commands/handlers/github/request-changes-after-ci-fail.ts` (new) —
  `RequestChangesAfterCiFailHandler`, `ci_failed -> changes_requested`.
- `packages/core/src/github/client.ts` / `packages/github/src/octokit-client.ts` /
  `packages/testing/src/services/mock-github-client.ts` — new `GitHubClient.getPullRequestDiff()`
  method (Octokit's diff media type; a deterministic fake in the mock).
- `packages/core/src/github/reconcile.ts` — new `CI_FAILED` branch dispatching
  `RequestChangesAfterCiFailCommand`/`EscalateToHumanCommand`.
- `packages/adapters-reviewer/` (new package, `@minicoder/adapters-reviewer`) — `review-provider.ts`
  (`ReviewProvider` interface), `http-review-provider.ts` (`HttpReviewProvider`),
  `claude-reviewer-adapter.ts` (`ClaudeReviewerAdapter`).
- `packages/triggerdev/src/tasks/run-review.ts` (new) — the 17th canonical task id (`run-review`),
  bridging `under_review` to a real reviewer-adapter invocation and back into the state machine,
  mirroring `run-coder.ts`'s shape (`AgentRunRecorder`, `ExecutionLane`, `isTransientRace()`).
- `packages/triggerdev/src/tasks/run-coder.ts` — extended to also accept `fixing` (not just
  `coding`); on a fix-cycle push, writes one `coder_responses` row (`response_type='fixed'`) per
  currently-unresolved `review_findings` row and marks each resolved (the "optimistic fixed"
  simplification — `CoderOutput` carries no per-finding disposition today).
- Testing: `packages/testing/src/fixtures/review-fix-loop.ts` and
  `packages/testing/src/scenarios/review-fix-loop.ts` (new) exercise the real handlers/task end to
  end (main loop, fix-attempt-threshold escalation, CI-failure auto-blocking-finding path) — unlike
  the older `review-loop` fixture/scenario, which is left untouched.

**Explicitly deferred to later phases:** `RecordApprovedByPolicyCommand`/`MergeIfReadyCommand`/the
merge path and `merge_gate_evaluations` (Phase 12); `ArbiterAgentAdapter` wiring, disagreement
records, `human_required` disposition UI/API (Phase 11) — a coder response of `'disputed'` is
simply left for Phase 11 to pick up; per-finding/reopening fix-attempt granularity (docs/01 §5.8,
deliberately simplified to one aggregate counter — see scope decision #2 above).

Acceptance: reviewer output becomes structured findings; blocking findings trigger fixes;
non-blocking findings do not block merge; review-loop limits are enforced.

## Phase 11 — Disagreement, Arbiter, and Human Escalation ✓

> **Status: Complete** (2026-07-04)

Deliver disagreement detection, disagreement records, Arbiter adapter integration, the
human-required workflow, and escalation UI/API support.

Acceptance: repeated unresolved findings create disagreement records; automation stops on
`human_required`; a human can resolve, retry, skip, block, or resume.

**Delivered modules:**

- `packages/core/src/domain/states.ts` — new `FeatureExecutionState.SKIPPED` (`'skipped'`), a
  terminal state a human reaches via `SkipFeatureCommand`. Not in the original glossary §3.2/§3.3
  lists; added per the glossary's own editing rule (docs/00 §3.3).
- `packages/core/src/statemachine/machines/feature-execution.ts` — five new matrix rows, all
  `fromState: HUMAN_REQUIRED` (previously zero — `human_required` had no outgoing transitions at
  all before this phase): `ResolveDisagreementCommand` (→ `changes_requested`),
  `ResumeFeatureExecutionCommand` (→ `under_review`), `RetryFeatureCommand` (→ `selected`),
  `SkipFeatureCommand` (→ `skipped`), `BlockFeatureCommand` (→ `blocked`). All five are
  actor=`approver` (CLAUDE.md: disagreement resolution and guarded lifecycle actions require
  approver/admin).
- `packages/core/src/disagreement/` (new directory) — `detect.ts`'s `findRepeatedFinding()`
  (matches a current `blocking` finding's description against `review_findings` from an earlier
  `review_cycle` for the same feature run — the only available repeat signal, since Phase 10's
  "optimistic fixed" coder-push design already resolves every open finding on push, so a
  genuinely unfixed problem shows up as a _new_ row, never a reopened one — `requires_human_decision`
  is deliberately excluded, see the post-implementation review fix below); `write.ts`'s
  `insertDisagreementRecord()`/`recordArbiterDisposition()`/`findOpenDisagreement()`/
  `findDisagreementForFeatureRun()`/`resolveDisagreementByHuman()` (evidence-data writers for
  `disagreement_records`, the same non-`CommandHandler` posture `insertReviewFindings()` established
  in Phase 10, with deterministic
  `disagreement:{featureRunId}:{reviewCycle}` ids and `ON CONFLICT (id) DO NOTHING` for idempotent
  retry). `findOpenDisagreement()`/`resolveDisagreementByHuman()` match `state IN ('open',
'escalated')` — a disagreement the Arbiter already escalated still needs a human disposition, so
  it must remain findable, not just ones the Arbiter never reached.
- `packages/core/src/commands/handlers/feature/` — five new handlers:
  `resolve-disagreement.ts` (requires an open/escalated `disagreement_records` row — a
  `human_required` escalation unrelated to any disagreement has no such row and must use a
  different disposition), `resume-feature-execution.ts` (optionally resolves a disagreement in the
  coder's favor via an optional `disagreementId`), `retry-feature.ts` (re-checks
  `workflow_states.active_feature_run_id === featureRunId` before allowing the transition — a real
  finding during implementation: retrying a feature run that isn't the project's current active
  feature would land it at `selected` with no `active_feature_run_id` pointer to it, silently
  orphaning it, since neither `SelectFeatureHandler`'s CAS nor `start-next-feature`'s
  stranded-selected-run check would ever pick it up), `skip-feature.ts` and `block-feature.ts`
  (both clear `workflow_states.active_feature_run_id` when this run was the active one, mirroring
  `RecordMergedCommand`'s `clear_active_feature_run` side effect, so `start-next-feature` can
  select a different feature next). All five write `human_approvals` — its first production writer
  since the Phase 1 initial schema (the same "created-but-unwritten" pattern `cost_records`/
  `agent_context_packs` followed before Phase 8/9).
- `packages/core/src/commands/helpers.ts` — new `insertHumanApproval()`, mirroring
  `insertPolicyDecision()`'s shape.
- `packages/core/src/events/schemas.ts` — five new event payload schemas
  (`feature.disagreement_resolved`, `feature.resumed_from_human_required`, `feature.retried`,
  `feature.skipped`, `feature.blocked_by_human`), using `.min(1)` string IDs from the start (not
  `.uuid()` — see the Phase 9/10 review rounds that had to retrofit every other schema).
- `packages/triggerdev/src/tasks/run-review.ts` — disagreement detection and Arbiter invocation
  inserted into the existing `hasBlocking` branch, _after_ the unconditional fix-attempt-threshold
  escalation check (the threshold circuit breaker is independent of the Arbiter — docs/01 §5.8/§5.9
  — and is not something a disagreement resolution can override) and _before_ the ordinary
  `RecordChangesRequestedCommand` dispatch. No separate `run-arbiter` Trigger.dev task was added —
  the Arbiter call happens inline in the same task invocation as the Reviewer call, since
  arbitrating a disagreement is a sub-decision within processing the reviewer's output for this one
  review cycle, not an independently-schedulable unit of work the way `run-coder`/`run-review`
  themselves are. `RunReviewPayload` gained an optional `arbiterAdapterName`; `RunReviewDeps` gained
  an `arbiterAdapterFactory` with **no default resolver** — mirroring
  `planning-readiness-assessment`/`generate-implementation-plan`'s treatment of
  `PlannerAgentAdapter` (docs/06 Phase 6), since no reference `ArbiterAgentAdapter` implementation
  has shipped (docs/03 §9 lists only `GenericLLMPlannerAdapter`/`CodexCoderAdapter`/
  `ClaudeReviewerAdapter`/`GenericLLMDocumentationAdapter`). A live deployment that reaches a
  disagreement without one configured fails fast with an actionable error rather than silently
  skipping arbitration.
- `packages/cli/src/commands/human.ts` — new `minicoder human {resolve-disagreement, resume,
retry, skip, block}` CLI group, the first CLI surface to dispatch a real state-machine command
  directly (via `TransactionalCommandExecutor`) rather than only reading state or writing simulated
  inbox events — no async/durable-retry need for a one-shot human disposition justifies a
  Trigger.dev task here. Uses the existing `humanActor()` helper (`packages/triggerdev/src/tasks/
actor.ts`, already exported from `@minicoder/triggerdev`) to build the human `ActorIdentity`.
- `packages/testing/src/fixtures/disagreement-arbiter.ts` /
  `packages/testing/src/scenarios/disagreement-arbiter.ts` — new fixture/scenario pair exercising
  all three disagreement outcomes against a single feature run across three review cycles: cycle 1
  establishes the finding (nothing to repeat yet), cycle 2 repeats it and the Arbiter resolves in
  the reviewer's favor (continues to `fixing`), cycle 3 repeats again and the Arbiter escalates
  (reaches `human_required`). Uses `MockReviewerAdapter`'s pre-existing `'repeat_finding'` behavior
  (already present in `packages/testing/src/adapters/mock-reviewer.ts` before this phase, evidently
  anticipating exactly this scenario) and `MockArbiterAdapter`'s existing `'resolve'`/`'escalate'`
  behaviors (also pre-existing from Phase 5).
- **Known limitation, documented not solved (see docs/00 §3.3's `skipped` note and
  `block-feature.ts`'s doc comment):** a `skipped` feature never reaches `merged`, so
  `feature_dependencies`-based downstream guards never clear automatically for anything depending
  on it; and a human-initiated `BlockFeatureCommand` has no matching human-initiated unblock —
  `UnblockFeatureCommand`'s guard checks dependency-clearing, not human disposition, so a
  human-blocked feature with no unmet dependency currently requires a direct `minicoder state
repair` to recover. Both are the same "documented, not solved" posture this codebase already
  applies elsewhere to a deliberate human decision's cross-cutting consequences.
  **The first of these two is now closed (issue #52):** `SkipFeatureHandler` now cascades, in the
  same transaction as the skip itself, transitioning every dependent feature run still at
  `approved_pending_execution` to `blocked` (a new `approved_pending_execution -> blocked` matrix
  row triggered by `SkipFeatureCommand`) — surfacing the problem via the existing `blocked`-state
  diagnostics instead of leaving the dependent silently stuck forever. `state doctor` gained a
  `skipped_dependency` check as defense-in-depth for any case that predates this fix. The second
  limitation (human-blocked has no human-driven unblock) remains open — see issue #53.

**Post-implementation review fixes (round 1):**

- **HIGH (a caller-supplied `disagreementId` was trusted bare).** `ResolveDisagreementHandler`/
  `ResumeFeatureExecutionHandler` accepted an optional `disagreementId` and passed it straight to
  `resolveDisagreementByHuman()` with no check that it belonged to the feature run in question, was
  still open/escalated, or existed at all — a bogus id silently updated 0 rows while the feature
  run's `human_required -> changes_requested`/`under_review` transition proceeded anyway, and a
  valid id from a _different_ feature run's disagreement would have mutated that other record.
  Fixed with a new `findDisagreementForFeatureRun()` (`packages/core/src/disagreement/write.ts`),
  which scopes the lookup to `id + feature_run_id + state IN (open, escalated)`; both handlers now
  call it before proceeding and reject with a 409 `no-open-disagreement` `CommandError` if it
  returns `null`. `resolveDisagreementByHuman()` itself was also changed to scope its `UPDATE` by
  `feature_run_id` (defense-in-depth) and to return the affected-row count, so a second layer
  catches a 0-row update (e.g. a disagreement resolved by a concurrent request within the same
  idempotency window) instead of the caller assuming success.
- **MEDIUM (`findRepeatedFinding()`'s doc comments and candidate filter claimed
  `requires_human_decision` findings were included in repeat detection, but the control flow made
  that unreachable).** `run-review.ts`'s `hasRequiresHumanDecision` branch escalates that severity
  to `human_required` unconditionally and returns before `findRepeatedFinding()` is ever called —
  so a repeated `requires_human_decision` finding never actually opened a `disagreement_records`
  row or invoked the Arbiter, contradicting the shipped doc comments. Rather than restructuring
  `run-review.ts`'s control flow to run detection before that early return (a real option, but one
  that complicates the most-reviewed function in this codebase for a case that arguably shouldn't
  be arbitrated anyway), this was fixed by narrowing `findRepeatedFinding()` to `blocking` severity
  only and documenting why: `requires_human_decision` is the Reviewer's own explicit call that
  something is beyond automation scope, and the Arbiter second-guessing that would undermine the
  Reviewer's authority to make it — the Arbiter's actual role (docs/03 §5) is resolving a
  coder/reviewer disagreement over a recurring `blocking` finding, not vetting a Reviewer decision
  to punt to a human. docs/01 §5.9 and this section were updated to match.

## Phase 12 — Merge Gate and Branch Protection ✓

> **Status: Complete** (2026-07-04)

Deliver the merge-policy engine, the `minicoder/review-gate` status check, the
merge-if-ready command (approver/admin-initiated; re-gates before the GitHub merge),
branch-protection documentation/checks, and structured **`merge_gate_evaluations`** evidence records
(CI/review/findings/conversation/branch-protection/budget/human-approval inputs + final decision —
see [`01-system-specification.md`](01-system-specification.md) §12).

Acceptance: unsafe PRs cannot be merged by MiniCoder; safe PRs merge through policy; every gate run
writes an evidence record; the database updates after merge; the next feature starts only after
merge.

**Delivered modules:**

- `packages/core/src/merge-gate/` (new directory) — `evaluateMergeGate(tx, {featureRunId,
projectId, featureRequestId})`: the merge-policy engine. Reads CI status and review state from
  the `pull_requests` mirror, unresolved `blocking`/`requires_human_decision` `review_findings`,
  a blocking-labels policy (`resolveBlockingLabelsPolicy()`, env-overridable via
  `MERGE_GATE_BLOCKING_LABELS`, default `do-not-merge`/`wip`/`blocked`), `evaluateBudget()`'s
  feature-scoped budget status, outstanding (`rejected`/`deferred`) `human_approvals` rows, and
  `pull_requests.mergeable` as the `branch_protection_ok` proxy — then **always** writes a
  `merge_gate_evaluations` evidence row (win or lose) before returning `approved`/`rejected` plus
  the list of failing reasons. `evaluateBudget()`'s parameter type was widened from `DbClient` to
  `TxClient` (it only ever calls `.query()`) so this evaluator can run inside a caller's own
  transaction. Deliberately does **not** evaluate `pull_requests.conversations_resolved` — see the
  file's doc comment and the `no-conversations-resolved-gate.test.ts` fitness test, which
  intentionally excludes this file from its allow-list.
- `packages/core/src/commands/handlers/feature/record-approved-by-policy.ts` —
  `RecordApprovedByPolicyHandler` (`under_review -> approved_by_policy`). Two-phase, not one
  atomic transaction: `evaluateMergeGate` runs first in its own transaction (always commits the
  evidence row), and only on `approved` does a second transaction claim the idempotency key and
  perform the state transition — a single all-or-nothing transaction would roll the evidence
  write back along with a rejected transition, losing the audit trail for every blocked attempt.
  A rejection throws a non-fatal `CommandError` (`type: 'merge-gate-blocked'`).
- `packages/core/src/commands/handlers/feature/merge-if-ready.ts` — `MergeIfReadyHandler`
  (`approved_by_policy -> merge_ready`, actor = `approver`/`admin`). Same two-phase shape;
  re-evaluates the gate from scratch immediately before the real GitHub merge call (docs/01 §12).
- `packages/core/src/commands/handlers/feature/record-merged.ts` — `RecordMergedHandler`
  (`merge_ready -> merged`): records the merge SHA onto `pull_requests` and clears
  `workflow_states.active_feature_run_id` (mirroring `SkipFeatureHandler`/`BlockFeatureHandler`'s
  identical clear), satisfying "the next feature starts only after merge."
- `packages/core/src/commands/handlers/feature/record-merge-failed.ts` /
  `reconcile-merge-failed.ts` — `RecordMergeFailedHandler` (`merge_ready -> merge_failed`, records
  an `autoClearable` classification) and `ReconcileMergeFailedHandler`
  (`merge_failed -> under_review`, the auto-clear path). `EscalateToHumanCommand` (already generic
  across every non-terminal state since Phase 7) handles `merge_failed -> human_required` — no new
  handler needed. Fixed two pre-existing matrix rows' idempotency keys while implementing them:
  `record-merge-failed`/`reconcile-merge-failed` gained an `{expectedVersion}` discriminator (the
  same class of bug documented elsewhere in this file for `start-fixing`/budget-control keys — a
  feature run can cycle through `merge_failed` more than once).
- `packages/core/src/github/client.ts` — new `GitHubClient.mergePullRequest()` method,
  `MergePullRequestOptions`, and `GithubMergeRejectedError` (`reason: 'sha_mismatch' |
'not_mergeable' | 'unknown'`, `autoClearable: boolean`). `OctokitGitHubClient.mergePullRequest()`
  (`packages/github`) classifies GitHub's rejection status codes: 409 (head moved since the gate
  re-evaluated) → `sha_mismatch`/auto-clearable; 405 (branch protection or a real conflict — GitHub
  does not distinguish the two) → `not_mergeable`/not auto-clearable; anything with no HTTP status
  (a genuine infra/auth failure) is rethrown as-is rather than misclassified as a merge rejection.
- `packages/core/src/merge-gate/publish-status-check.ts` — `publishMergeGateStatusCheck()`, a thin
  shared wrapper publishing the `minicoder/review-gate` status check (docs/00 §3.11) — the first
  production caller of `GitHubClient.publishStatusCheck()`, which existed unwritten since Phase 7.
- `packages/triggerdev/src/tasks/run-merge-gate.ts` — new `run-merge-gate` task (18th canonical
  task ID): the operator-triggered "recompute merge gate" action (docs/00 §4.4). A feature run at
  `under_review` with no automatic follow-up (Phase 10's documented posture — "Phase 12's Merge
  Gate owns that transition") gets one here. Dispatches `RecordApprovedByPolicyCommand` and
  publishes the status check afterward regardless of outcome; a status-check publish failure is
  logged and swallowed, never thrown (mirrors `run-coder.ts`'s "PR-creation failure after a
  successful push is never re-thrown" contract) — the state transition is already durably recorded
  by that point. A separate, independently scheduled/triggered task from `run-review.ts`/
  `run-coder.ts`/`start-next-feature.ts` (CLAUDE.md's "never inline" rule).
- `packages/cli/src/commands/merge.ts` — new `minicoder merge merge-if-ready` CLI command: the
  only synchronous, approver-initiated action in the merge path, mirroring `minicoder human ...`'s
  "one-shot dispatch, no Trigger.dev task needed" shape (a human-approved merge has no
  async/durable-retry need). Sequence: `MergeIfReadyCommand` re-gates and transitions to
  `merge_ready`; only on success does it call the real `GitHubClient.mergePullRequest()`; the
  outcome is recorded via `RecordMergedCommand` or `RecordMergeFailedCommand` +
  `ReconcileMergeFailedCommand`/`EscalateToHumanCommand` (classified by
  `GithubMergeRejectedError.autoClearable`). Publishes the status check both on a rejected re-gate
  and on a passed one before attempting the merge.
- `packages/testing/src/services/mock-github-provider.ts` / `mock-github-client.ts` — new
  `MockGitHubProvider.simulateMergeConflict(prNumber, reason)` test seam and
  `MockGitHubClient.mergePullRequest()` (succeeds via `simulatePrMerged`, or throws a classified
  `GithubMergeRejectedError` per the seam).
- `packages/testing/src/fixtures/merge-gate.ts` / `scenarios/merge-gate.ts` — rewrote the
  pre-existing placeholder scenario (which drove `feature_runs`/`feature_requests.state` via raw
  SQL rather than the real state machine, in violation of the documented "`feature_requests.state`
  is a static label" invariant) into four feature runs exercising every Merge Gate outcome: a clean
  happy path all the way to `merged`; a rejected gate (unresolved blocking finding); a
  `sha_mismatch` merge rejection auto-clearing back to `under_review`; and a `not_mergeable`
  rejection escalating to `human_required`.
- `packages/core/src/events/schemas.ts` — four new event schemas
  (`feature.approved_by_policy`/`feature.merge_ready`/`feature.merge_failed`/
  `feature.returned_to_review`), following the existing `.min(1)` (never `.uuid()`) ID convention.

**Deviations from the original plan:**

- "Required conversations are resolved" (docs/01 §12) remains a documented, deliberate non-gate:
  `pull_requests.conversations_resolved` is still a hardcoded `false` placeholder (GitHub REST has
  no such flag; GraphQL support is tracked in issue #36) and wiring it into a hard gate would
  permanently block every real merge. The architectural fitness test guarding this
  (`no-conversations-resolved-gate.test.ts`) was left unmodified — `evaluate-merge-gate.ts` is not
  on its allow-list, so it cannot reference this field even by accident.
- Blocking labels use a single, deployment-wide policy list (env-overridable), not a per-project
  policy table — a future per-project override can be layered on top of
  `resolveBlockingLabelsPolicy()` without changing the gate's shape.

**Post-implementation review fixes:** two rounds of code review found and fixed real correctness
bugs before this phase's PR merged — see CLAUDE.md's Merge Gate and Branch Protection Operational
Constraints section for the full rationale. Round 1 (HIGH): the `approved-by-policy`/`merge-ready`
idempotency keys were not `{expectedVersion}`-scoped, and `OctokitGitHubClient.mergePullRequest()`
misclassified every non-409/405 HTTP status (401/403/404/422/429/5xx) as a merge-gate rejection
instead of rethrowing genuine operational failures; also fixed (MEDIUM/LOW): the CLI didn't swallow
status-check publish failures the way the Trigger.dev task does, blocked-gate reasons were
reconstructed by parsing error-message prose instead of a typed `MergeGateBlockedError`, and a
stale doc comment described one-transaction atomicity after the handlers moved to a two-phase
evidence-then-transition design. Round 2 (HIGH): `evaluateMergeGate()` didn't enforce three
documented preconditions — belongs to the active feature, PR is open, targets the correct base
branch — closing a real gap between docs/01 §12 and the implementation; also fixed (MEDIUM): the
`escalate-human-merge-failed` idempotency key had the same un-scoped-key bug as round 1's HIGH
finding, just on a row round 1 didn't touch. A third re-review found no further blocking issues;
two non-blocking watchlist notes (a redundant pre-merge re-fetch, and the single-repo-per-project
assumption already shared by every other repository lookup in the codebase) were evaluated and
left as-is with documented rationale rather than fixed.

## Phase 13 — Orchestrator API ✓

> **Status: Complete** (2026-07-05)

Deliver the Fastify API: read endpoints, command endpoints, **webhook endpoints**, state/diagnostics
read models, **wiring of the Phase-2 local auth + actor identity into the API surface**, a role
model, the **full per-command contract**
(completing the contracts introduced in Phase 2; see
[`01-system-specification.md`](01-system-specification.md) §9), and an
**OpenAPI-first** description honoring the API conventions (command envelope, idempotency-key header,
problem-details errors, cursor pagination, audit metadata), plus API tests.

Acceptance: the API exposes database-backed view models; API commands call core commands; no
arbitrary state-mutation endpoints are required; requests follow the API conventions and validate
against the OpenAPI description; webhook deliveries are accepted and verified; the UI can be built on
the API.

**Delivered modules:**

- `packages/api/` (new package) — the Fastify Orchestrator API. `src/app.ts`'s `buildApp()` wires
  together auth, OpenAPI conformance hooks, a global RFC 9457 error handler, health/webhook/read
  routes, and the command surface; `src/server.ts`'s `serve()` is the standalone entrypoint reading
  `MINICODER_API_KEYS`/`GITHUB_WEBHOOK_SECRET` from env, matching `packages/github`'s
  `createWebhookApp()` bootstrap pattern.
- `packages/api/src/auth/` — `ApiKeyProvider` (static `MINICODER_API_KEYS`-driven, SHA-256-hashed
  key lookup — no session/JWT infra exists anywhere in this repo, and docs/07 defers real hosted
  OAuth/SSO) and `registerAuthHook()` (a global `onRequest` hook resolving `Authorization: Bearer
<api-key>` into `request.actor: ActorIdentity`, exempting `/webhooks/*`/`/healthz`/`/readyz`).
- `packages/api/src/commands/registry.ts` — `buildCommandRegistry()`, the first production
  consumer of `@minicoder/core`'s `CommandRegistry` (built in Phase 2, never populated until now).
  Registers every `human`-actorKind `CommandHandler` except `MergeIfReadyHandler` (dedicated route
  below), plus a narrow `system`-actorKind allow-list for manual replay
  (`GenerateImplementationPlanHandler`/`GenerateFeatureBacklogHandler`/`ValidateBacklogHandler`;
  `AssessPlanningReadinessHandler` is excluded — its constructor requires a live
  `PlannerAgentAdapter` instance, and no reference planner adapter has shipped yet, docs/02 §7).
- `packages/api/src/commands/generic-dispatch-route.ts` — `POST /commands/:commandSlug`, resolving
  a URL slug to a registered `commandName`, building a `CommandEnvelope` from the request body +
  `Idempotency-Key` header + auth-derived actor, and dispatching via
  `TransactionalCommandExecutor` — structurally guaranteeing "no arbitrary state-mutation
  endpoints" (only registered handlers are ever reachable).
- `packages/api/src/commands/merge-if-ready-route.ts` — `POST /commands/merge-if-ready`, a
  dedicated (non-generic) route mirroring `packages/cli/src/commands/merge.ts`'s chained
  `MergeIfReadyHandler` → real `GitHubClient.mergePullRequest()` → `RecordMergedHandler`/
  `RecordMergeFailedHandler`+follow-up sequence.
- `packages/api/src/commands/task-trigger-routes.ts` — `POST /commands/{request-coder-run,
request-review,request-fixes,recompute-merge-gate}`, "enqueue" routes returning
  `{triggerdevRunId, accepted}` via an injectable `TaskTriggerClient` (no default Trigger.dev SDK
  client constructed automatically — mirrors the "no default adapter, inject only" posture already
  established for `PlannerAgentAdapter`/`ArbiterAgentAdapter`). `request-fixes` re-triggers
  `request-review`, since `StartFixingCommand` has no standalone task of its own.
- `packages/api/src/commands/diagnostics-routes.ts` — `POST /commands/{validate,doctor,reconcile,
export-diagnostics}`, thin wrappers over `read-models/diagnostics.ts`.
- `packages/api/src/read-models/` — query functions for every docs/01 §9 read-endpoint group
  (projects, repositories, GitHub links, specification inputs, planning readiness, clarification
  sessions, plans, features, active feature, pull requests, agent runs/adapters/configuration,
  review findings, disagreements, policy decisions, costs, budgets, artifacts, design documents,
  workflow events, status), plus `merge_gate_evaluations` (added as an explicit group beyond
  docs/01's original list — it has existed with a production writer since Phase 12 with no read
  path). `diagnostics.ts` is extracted from `packages/cli/src/commands/state.ts`'s inline SQL so
  the CLI and API share one implementation; `packages/cli/src/commands/state.ts`'s
  `validate`/`doctor`/`reconcile`/`export-diagnostics` commands now call these same functions.
  `pagination.ts` provides the shared cursor-pagination helper (`listByCreatedAt()`) every list
  read-model uses.
- `packages/api/src/routes/webhooks.ts` — mounts `registerGithubWebhookRoute()` from
  `@minicoder/github` (unchanged) directly onto the shared app instance, per that module's own
  Phase-7 doc comment anticipating this. `packages/github/src/webhook-app.ts`'s
  `addRawBodyCapture()` was changed from a private helper to an exported function so the API can
  install the same raw-body-capturing content-type parser its HMAC verification depends on.
- `packages/api/src/errors.ts` — `toProblemDetails()`, the single RFC 9457 problem-details
  dispatcher registered as Fastify's global error handler, mapping `CommandError` (pass-through,
  already RFC 9457-shaped — this also covers `MergeGateBlockedError`, which extends it),
  `AuthorizationError`, `TransitionError`, `GithubMergeRejectedError`, and this package's own
  `NotFoundError`/`MissingIdempotencyKeyError`/`RequestValidationError`/`UnauthenticatedError`.
- `packages/api/openapi/openapi.yaml` — hand-authored OpenAPI 3.1 contract (not code-generated, to
  avoid ESM-only/heavy codegen tooling fighting this repo's CommonJS build target), covering every
  route. `packages/api/src/openapi/register-openapi-hooks.ts`'s `onRoute` hook throws **at
  route-registration time** if a route has no matching spec operation, so spec drift fails the
  build immediately rather than only in a separate test; a `preHandler` hook additionally validates
  the `limit` query parameter against its declared `[1, 100]` integer schema. Per-command request
  bodies are intentionally a generic `CommandPayload: type: object` rather than hand-transcribing
  20+ Zod schemas into JSON Schema — real payload validation is enforced by each dispatched
  handler's own already-tested Zod schema.
- `packages/core/src/index.ts` — now exports `ApprovePlanHandler`/`ApprovePlanCommand`
  (`packages/core/src/commands/handlers/plan/approve-plan.ts`), built in Phase 6 but never
  exported or called anywhere until this phase gave it a command endpoint (`approve-plan`).
- `packages/cli/src/commands/api.ts` — new `minicoder api serve [--port] [--host]`, mirroring
  `minicoder github serve`'s shape; wired into `packages/cli/src/index.ts`.
- `vitest.config.ts` / root `package.json` — `@minicoder/api` added to the vitest alias map and to
  the ordered `typecheck` script chain (after `testing`, since `packages/cli`'s `state.ts` and
  `packages/api`'s own test helpers both resolve `@minicoder/api`/`@minicoder/testing` types).
- Test coverage (`packages/api/src/**/*.test.ts`, 45 tests): auth middleware (valid/invalid/missing
  key, webhook exemption, correlation-id handling), generic command dispatch (happy path,
  idempotency replay without re-running side effects, role/actor-kind rejection, unknown-command
  404), the merge-if-ready route (missing-params 400, missing-PR/repo 404, merge-gate-blocked 409
  with structured reasons), task-trigger routes (each enqueue route calling its injected client,
  the unconfigured-client fail-fast error), diagnostics routes, read-endpoint smoke tests, webhook
  mounting delegation, OpenAPI conformance (route/spec parity enforced by construction, `limit`
  parameter validation), and problem-details shape for every mapped error type.

**Deviations from the original plan / deferred items** (confirmed scope decisions):

- `generate final design document` / `approve final design document` (docs/01 §9) are **not
  built** — no core command handler exists yet (Phase 17 — Final Design Document Generator — will
  add both the handler and its endpoint). Scaffolding a `501` route was considered and rejected: it
  would violate "API commands call core commands."
- The Trigger.dev **management**-API client (`minicoder trigger deploy/list-runs/inspect-run/
cancel-run/replay-run/drain-queue/reset-dev/reconcile`) remains **out of scope** — those CLI stub
  comments refer to a different, external system (Trigger.dev's own control plane), not the
  Orchestrator API this phase builds. Only this phase's own diagnostics endpoints are in scope.
- `state repair --apply` stays **CLI-only** — its confirmation-token flow is a local file
  (`~/.minicoder/pending-repair-token.json`) that does not translate to a stateless HTTP API.
- `Idempotency-Key` is **client-supplied and used verbatim**, not server-synthesized from
  `{commandName}:{resourceId}:{expectedVersion}` the way existing CLI/task callers build their own
  keys — a deliberate API-contract decision (Stripe-style), not an inconsistency with that
  convention.

## Phase 14 — Ink Text UI

Deliver dashboard, feature queue, active feature, planning/clarification, review findings, agent
runs, cost, human-required, artifact, adapter, and state-health views.

Acceptance: the TUI uses the API only; triggers allowed commands; and shows Workflow Layer
task/waitpoint and state-health status via the API.

## Phase 15 — Next.js Web UI

Deliver dashboard, planning review, clarification workflow, feature detail, PR/review detail,
disagreements, human-required queue, cost dashboard, artifact manager, adapter manager, state-health
page, and design-document review page.

Acceptance: the Web UI uses the API only; RBAC is enforced by the backend; human approvals work;
artifact exports are visible as snapshots.

## Phase 16 — Observability, Cost, and Recovery

Deliver the workflow timeline, agent-run trace view, Workflow Layer run mapping, cost dashboards,
budget forecasting and reporting (the **budget-gate primitive ships in Phase 8**),
recovery/reconciliation commands, secret-redaction checks, and optional OpenTelemetry-compatible
export.

Acceptance: operators can reconstruct workflow history; budgets can pause automation; recovery
commands are safe and audited; private chain-of-thought is not stored.

## Phase 17 — Final Design Document Generator

Deliver design-document tables, design-decision records, the `DocumentationAgentAdapter`, the Design
Document Generator, the Workflow Layer design-document task, the final-document review workflow,
`final-design-document.md` export, and the automated **Project Acceptance Validation** suite (full
tests, migration validation, build, lint/typecheck, security scan, docs-completeness, state-doctor/
reconciliation pass, artifact-export pass — see [`01-system-specification.md`](01-system-specification.md) §13.1).

Required sections (13): Purpose and Scope; Goals and Constraints; System Context; Architecture
Overview; Component Design; Data Design; API and Interface Design; Workflows and Runtime Behavior;
Deployment and Infrastructure; Observability and Operations; Testing Strategy; Design Decisions;
Glossary.

Acceptance: Project Acceptance Validation passes before `implementation_complete`; generation starts
only after implementation completion; all 13 sections are present; the document is generated from
database and GitHub evidence; a human can approve or request revision; the project reaches
`project_complete` only after approval.

## Phase 18 — Future Extensions

Deferred: parallel feature execution, multi-repository orchestration, additional coder/reviewer
adapters and their provider-adapter conformance fixtures (the conformance **framework** and mock
conformance ship in Phase 5), additional SCM providers, optional advanced RBAC, and optional
PDF/DOCX export. (Trigger.dev backend tiers — self-host single-node default, self-host HA cluster,
Cloud — are a Phase 3 deployment concern, not a deferred extension.)

Acceptance: at least one alternative adapter can be added without changing core orchestration; future
extensions do not change the baseline architecture.
