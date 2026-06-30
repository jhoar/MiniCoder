# MiniCoder — Implementation Plan

> Status: Canonical
> Supersedes: minicoder_combined_implementation_plan.md,
> minicoder_combined_implementation_plan_testing_updated.md
> Version: 1.0.6
> Last-updated: 2026-06-30

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
  database (not just the `triggerdev_runs` metadata table). This wiring lands with Phase 6
  (Bootstrap Planner) for the planner tasks and Phase 7/8 for reconciliation/execution tasks.
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

Deliver the six role interfaces, an adapter registry, the capability model, the mock adapters and
`HumanTestAdapter`, adapter run records, and adapter conformance tests (see
[`03-agent-adapter-architecture.md`](03-agent-adapter-architecture.md)).

Acceptance: core does not depend on provider SDKs; mock adapters run through Workflow Layer task
wrappers; `agent_runs` records are created; capability validation works; and the conformance
framework runs the six mock adapters and `HumanTestAdapter` to green, writing
`adapter_conformance_results`. (Provider-adapter conformance fixtures for additional adapters are
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
- `packages/migrations/migrations/0004_agent_runs_provenance.*` — adds four immutable provenance
  columns to `agent_runs`: `adapter_name TEXT`, `adapter_implementation TEXT`,
  `adapter_version INTEGER`, and `capabilities_used TEXT`. These are populated from an
  `AdapterRunSnapshot` at invocation time and never updated, so historical records remain
  attributable after adapter re-registration.
- `packages/migrations/migrations/0005_conformance_skipped_tests.*` — adds `skipped_tests INTEGER
NOT NULL DEFAULT 0` to `adapter_conformance_results`, tracking how many scenarios were
  intentionally skipped (e.g. `invalid_output_handling` is N/A for non-Coder adapters).

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
0003–0005 extend them without recreating any tables.

## Phase 6 — Bootstrap Planner, Readiness, and Clarification

Deliver specification ingestion, Planning Readiness Assessment, clarification sessions/questions/
answers, assumption and gap records, plan generation, feature-request generation, dependency/
acceptance-criteria/test-expectation generation, human approval, backlog activation, and
plan.md/backlog.md export/import (see [`02-bootstrap-planner-clarification.md`](02-bootstrap-planner-clarification.md)).

Acceptance: sufficient input generates a draft plan; insufficient input creates clarification
questions; blocking gaps prevent activation; an approved plan activates features as
`approved_pending_execution`; no runtime logic reads `backlog.md` as a source of truth.

## Phase 7 — GitHub Webhooks, Integration, and Reconciliation

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

## Phase 8 — Execution Orchestrator

Deliver the select-next-feature and start-feature commands, active-feature run records
(`feature_runs`), PR/CI tracking, the Workflow Layer execution flow, feature-progress events,
sequential policy enforcement, pause/resume, and a **minimal budget-gate primitive**: budget
thresholds (`budget_policies`, project/feature/review-cycle scopes), soft/hard limit evaluation, and
the `paused_budget_exceeded` / `waiting_for_budget_approval` transitions (glossary §3.8). Cost
dashboards, forecasting, and export remain Phase 16.

Acceptance: only one feature is active at a time (by policy); eligible features are selected in
sequence; dependencies are enforced; a soft/hard budget breach pauses automation and records a
`policy_decision`/`cost_record`; mock execution progresses through the happy path.

## Phase 9 — Reference Coder Adapter

Deliver a reference Coder adapter (e.g., `CodexCoderAdapter`), coder context packs, branch-update
handling, commit/push tracking, and coder-run cost/token records.

Acceptance: the adapter implements `CoderAgentAdapter`; the orchestrator does not call provider APIs
directly; a coder run can update a branch; changed files/commits are recorded.

## Phase 10 — Reference Reviewer Adapter and Review/Fix Loop

Deliver a reference Reviewer adapter (e.g., `ClaudeReviewerAdapter`), a structured review-finding
parser/normalizer, the review/fix loop task, coder-response records, and review-cycle counting.

Acceptance: reviewer output becomes structured findings; blocking findings trigger fixes;
non-blocking findings do not block merge; review-loop limits are enforced.

## Phase 11 — Disagreement, Arbiter, and Human Escalation

Deliver disagreement detection, disagreement records, Arbiter adapter integration, the
human-required workflow, and escalation UI/API support.

Acceptance: repeated unresolved findings create disagreement records; automation stops on
`human_required`; a human can resolve, retry, skip, block, or resume.

## Phase 12 — Merge Gate and Branch Protection

Deliver the merge-policy engine, the `minicoder/review-gate` status check, the
merge-if-ready command (approver/admin-initiated; re-gates before the GitHub merge),
branch-protection documentation/checks, and structured **`merge_gate_evaluations`** evidence records
(CI/review/findings/conversation/branch-protection/budget/human-approval inputs + final decision —
see [`01-system-specification.md`](01-system-specification.md) §12).

Acceptance: unsafe PRs cannot be merged by MiniCoder; safe PRs merge through policy; every gate run
writes an evidence record; the database updates after merge; the next feature starts only after
merge.

## Phase 13 — Orchestrator API

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
