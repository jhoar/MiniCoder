# MiniCoder — Testing, Validation, and State Lifecycle Specification

> Status: Canonical
> Supersedes: minicoder_testing_validation_state_lifecycle_specification.md
> Version: 1.0.0
> Last-updated: 2026-06-12

The canonical CLI surface is defined once in [`00-glossary-and-terms.md`](00-glossary-and-terms.md)
§5; commands referenced here are a subset of that surface.

## 1. Purpose

This document defines the testing, validation, and state-lifecycle management requirements for
MiniCoder. MiniCoder is itself an automation system; therefore every workflow must be testable
without manual intervention. Humans approve real work, but tests must be fully automated.

## 2. Core Requirement

MiniCoder shall be fully testable in unattended mode across unit tests, integration tests, system
tests, Docker, Docker Compose, Kubernetes, CI, and staging.

All stateful subsystems must have lifecycle-management tools for development, CI, staging, and
production-safe maintenance. Stateful subsystems include the MiniCoder database; the Workflow
Layer's tasks, runs, queues, schedules, retries, and waitpoints (Trigger.dev); GitHub
webhook/event state; GitHub
PR/check/review simulation; agent-adapter run state; artifact exports/imports; cost records; human
approval records; and final design document records.

## 3. Testability Principles

### 3.1 No Human Required for Tests
No automated test scenario shall require a human to click a UI button, manually approve a workflow,
or manually manipulate external systems. Human actions are simulated through deterministic test
fixtures, API commands, mock adapters, or test-mode approvals.

### 3.2 Mock Providers by Default
Most tests must run without real Codex, real Claude, real paid LLM calls, real GitHub repository
mutation, real human approval, or real production Trigger.dev state.

### 3.3 Deterministic Scenarios
System tests must use deterministic fixtures so failures are reproducible.

### 3.4 Test Mode Is a First-Class Runtime Mode
MiniCoder provides a formal `system_test` mode:

```yaml
mode: system_test

agents:
  planner: mock-planner
  coder: mock-coder
  reviewer: mock-reviewer
  arbiter: mock-arbiter
  documentation: mock-documentation
  human: human-test          # HumanTestAdapter — deterministic mock of HumanAgentAdapter (§4.2 glossary)

github:
  provider: mock

trigger:
  provider: triggerdev-test

database:
  reset_on_start: true
  seed_fixture: planning-review-merge
```

### 3.5 Production Safety
Destructive commands must be safe by default. Production reset/purge operations must be blocked or
require explicit, auditable, strongly guarded overrides.

## 4. Testing Levels

### 4.1 Unit Tests
Cover pure/domain logic: state-machine transitions, policy checks, feature selection, dependency
validation, planning-readiness scoring, clarification gap classification, review-finding
classification, merge-gate evaluation, budget-gate evaluation, idempotency behavior, disagreement
detection, and final-design-document eligibility. Unit tests must not require Docker, GitHub,
Trigger.dev, real agents, or network access.

### 4.2 Integration Tests
Cover subsystem boundaries: database repositories, migrations, command handlers, outbox/inbox
processing, Workflow Layer task wrappers, GitHub client against a mocked API, agent adapters with mock
providers, artifact import/export, API endpoints, cost manager, and the design document generator.
Integration tests run against **both** dialects — disposable SQLite databases **and** PostgreSQL
containers — as a matrix, not SQLite alone (see §8).

### 4.3 System Tests
Exercise end-to-end workflows with mock external systems.

Happy-path scenario:

```text
ingest specification
run readiness assessment
run clarification
generate plan
approve backlog
start feature
mock coder opens branch/PR
mock reviewer requests changes
mock coder fixes
mock reviewer approves
merge gate passes
feature merges
generate final design document
approve final design document
```

Additional scenarios:

```text
insufficient input → clarification questions
blocking gap unresolved → no backlog activation
review loop exceeded → human_required
budget exceeded → paused_budget_exceeded or waiting_for_budget_approval (glossary §3.8)
GitHub event race → workflow invalidated and reconciled
Trigger.dev task retry → idempotent completion
Trigger.dev waitpoint lost → reconciliation detects issue
database says running but Trigger.dev says failed → recovery path
```

### 4.4 Deployment Tests
Non-interactive validation for Docker, Docker Compose, and Kubernetes.

```text
deploy stack → run migrations → seed test project → execute system scenario
→ verify final state → export diagnostics → tear down
```

Kubernetes supports a Migration Job, Seed Job, System Test Job, Diagnostic Export Job, and
Reconciliation Job.

## 5. Required Lifecycle Tools

CLI tools for state-lifecycle management. The complete command surface lives in glossary §5. This
section specifies the behaviors each family must support.

### 5.1 Database Lifecycle
`minicoder db migrate | rollback | reset | seed | snapshot | restore | validate | diff | status`.

- SQLite local mode: create, migrate, reset, seed, snapshot, restore, validate.
- PostgreSQL hosted/team mode: migrate, safe rollback where supported, seed isolated test
  tenant/project, create isolated test schema/database, export diagnostics, restore from backup,
  validate migration status.

### 5.2 Trigger.dev Lifecycle
`minicoder trigger deploy | list-runs | inspect-run | cancel-run | replay-run | drain-queue |
reset-dev | validate | reconcile`.

Must handle stuck runs, failed runs, waiting runs, cancelled runs, duplicate runs, replayed runs,
orphaned waitpoints, queue backlog, and retry storms. Database correlation records track
`triggerdev_run_id`, `triggerdev_task_id`, `triggerdev_status`, `last_seen_at`,
`linked_workflow_event_id`, `linked_agent_run_id`, and `linked_feature_run_id` (table
`triggerdev_runs`, see [`01-system-specification.md`](01-system-specification.md) §8).

### 5.3 Workflow State Lifecycle
`minicoder state inspect | validate | reconcile | doctor | export-diagnostics | repair --dry-run`.

`doctor` detects database/Trigger.dev mismatch, database/GitHub mismatch, orphaned feature runs,
orphaned waitpoints, stale locks, stuck `human_required` states, failed outbox events, unprocessed
inbox events, stale artifact exports, and inconsistent cost records.

### 5.4 GitHub Simulation (test/dev only)
`minicoder github simulate-pr-opened | simulate-pr-synchronized | simulate-check-passed |
simulate-check-failed | simulate-review-approved | simulate-review-requested-changes |
simulate-pr-merged | simulate-pr-closed`.

### 5.5 Test Scenario Runner
`minicoder test unit | integration | system | scenario <name>`. The scenario runner returns
non-zero exit codes on failure for CI/CD use.

## 6. Mock Services and Adapters

Required mock adapters: `MockPlannerAdapter`, `MockCoderAdapter`, `MockReviewerAdapter`,
`MockArbiterAdapter`, `MockDocumentationAdapter`, `HumanTestAdapter`.

Required mock external systems: `MockGitHubProvider`, `MockTriggerRunner` (or a Trigger.dev test
harness wrapper), `MockCostProvider`, `MockArtifactStorage`.

Mock scenarios: planner returns sufficient / insufficient / sufficient_with_assumptions; coder
succeeds / fails / produces invalid output; reviewer approves / requests changes / repeats the same
finding; arbiter resolves / escalates; documentation generator succeeds / requires revision.

## 7. Production Safety Requirements

Destructive commands (`minicoder db reset`, `minicoder trigger reset-dev`, `minicoder state repair`)
must require an environment check, role/permission check, dry-run where possible, backup check where
applicable, explicit confirmation flag, and an audit event. Production reset is normally disallowed.
There is no unguarded bulk `purge`; irreversible maintenance is performed only through these guarded
workflows.

```bash
minicoder db reset --env development
```

## 8. CI/CD Requirements

GitHub Actions runs lint, typecheck, unit tests, integration tests, migration validation, a system
test smoke scenario, Docker build, Docker Compose test (where applicable), and Trigger.dev task
deployment validation. Longer system tests may run nightly or on release branches.

**Cross-dialect matrix (required).** Migration validation and the integration suite run against
**both** database targets — SQLite and PostgreSQL — as parallel CI jobs, so dialect differences in
JSON querying, constraint behavior, and locking/transaction semantics are caught before release.

## 9. Kubernetes Requirements

Non-interactive testing via Jobs: migration job, seed job, system-test job, diagnostic-export job,
reconciliation job. Each job must be runnable unattended, emit structured logs, exit non-zero on
failure, and produce diagnostics when configured.

## 10. Acceptance Criteria

Satisfied when unit tests run without external services; integration tests run with disposable
databases and mocked providers; system tests run without real LLM calls or manual approval; Docker
Compose and Kubernetes system tests run non-interactively; database, Trigger.dev, and state
lifecycle/doctor commands exist; GitHub simulation commands exist; production-destructive operations
are guarded; and CI can execute meaningful MiniCoder workflows automatically.

---

## 11. Operations and Runbooks

MiniCoder must ship operational runbooks (not only test harnesses). Each runbook is a documented,
rehearsable procedure backed by the lifecycle CLI (§5) and validated by a test scenario where
possible.

Required runbooks:

- **Backup and restore** — database snapshot/restore (`db snapshot`/`db restore`); PostgreSQL
  backup and point-in-time restore; restore drills.
- **Database migrations** — forward migrate and safe rollback (`db migrate`/`db rollback`),
  including the dual SQLite/PostgreSQL paths and migration-status validation.
- **Trigger.dev (self-host) operations** — resource sizing for webapp/Postgres/Redis/worker;
  version upgrades of the self-hosted stack; backup of its Postgres/Redis; queue draining
  (`trigger drain-queue`) and run replay (`trigger replay-run`).
- **Stuck-workflow recovery** — detect via `state doctor`; reconcile (`state reconcile`);
  cancel/replay orphaned runs; clear stale locks/leases and orphaned waitpoints.
- **GitHub webhook replay** — reprocess missed or failed inbox events; fall back to scheduled
  reconciliation; verify dedup keys prevent double-processing.
- **Secret rotation** — rotate GitHub App/PAT, provider tokens, and webhook signing secrets with
  zero stored plaintext; see `07-security-and-secrets.md`.
- **Disaster recovery** — full rebuild from backups + reconciliation against GitHub truth, with a
  documented RPO/RTO target.

Each runbook must state preconditions, the exact guarded commands, expected diagnostics output, and
a rollback/abort path.
