# MiniCoder — Testing, Validation, and State Lifecycle Management Specification

## 1. Purpose

This document defines the testing, validation, and state lifecycle management requirements for MiniCoder.

MiniCoder is itself an automation system. Therefore, every workflow must be testable without manual intervention.

Humans approve real work, but tests must be fully automated.

---

## 2. Core Requirement

MiniCoder shall be fully testable in unattended mode across:

- Unit tests.
- Integration tests.
- System tests.
- Docker deployments.
- Docker Compose deployments.
- Kubernetes deployments.
- CI environments.
- Staging environments.

All stateful subsystems must have lifecycle management tools for development, CI, staging, and production-safe maintenance.

Stateful subsystems include:

- MiniCoder database.
- Trigger.dev tasks, runs, queues, schedules, retries, and waitpoints.
- GitHub webhook/event state.
- GitHub PR/check/review simulation.
- Agent adapter run state.
- Artifact exports/imports.
- Cost records.
- Human approval records.
- Final design document records.

---

## 3. Testability Principles

### 3.1 No Human Required for Tests

No automated test scenario shall require a human to click a UI button, manually approve a workflow, or manually manipulate external systems.

Human actions must be simulated through deterministic test fixtures, API commands, mock adapters, or test-mode approvals.

### 3.2 Mock Providers by Default

Most tests must run without:

- Real Codex.
- Real Claude.
- Real paid LLM calls.
- Real GitHub repository mutation.
- Real human approval.
- Real production Trigger.dev state.

### 3.3 Deterministic Scenarios

System tests must use deterministic fixtures so failures are reproducible.

### 3.4 Test Mode Is a First-Class Runtime Mode

MiniCoder shall provide a formal `system_test` mode.

Example:

```yaml
mode: system_test

agents:
  planner: mock-planner
  coder: mock-coder
  reviewer: mock-reviewer
  arbiter: mock-arbiter
  documentation: mock-documentation

github:
  provider: mock

trigger:
  provider: triggerdev-test

database:
  reset_on_start: true
  seed_fixture: planning-review-merge
```

### 3.5 Production Safety

Destructive commands must be safe by default.

Production reset/purge operations must be blocked or require explicit, auditable, strongly guarded overrides.

---

## 4. Testing Levels

### 4.1 Unit Tests

Unit tests cover pure/domain logic.

Required coverage areas:

- State machine transitions.
- Policy checks.
- Feature selection.
- Dependency validation.
- Planning readiness scoring.
- Clarification gap classification.
- Review finding classification.
- Merge gate evaluation.
- Budget gate evaluation.
- Idempotency behavior.
- Disagreement detection.
- Final design document eligibility.

Unit tests must not require Docker, GitHub, Trigger.dev, real agents, or network access.

---

### 4.2 Integration Tests

Integration tests cover subsystem boundaries.

Required coverage areas:

- Database repositories.
- Migrations.
- Command handlers.
- Outbox/inbox processing.
- Trigger.dev task wrappers.
- GitHub client against mocked API.
- Agent adapters with mock providers.
- Artifact import/export.
- API endpoints.
- Cost manager.
- Design document generator.

Integration tests may use disposable SQLite databases and PostgreSQL containers.

---

### 4.3 System Tests

System tests exercise end-to-end MiniCoder workflows with mock external systems.

Required scenarios:

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
budget exceeded → paused or budget_override_required
GitHub event race → workflow invalidated and reconciled
Trigger.dev task retry → idempotent completion
Trigger.dev waitpoint lost → reconciliation detects issue
database says running but Trigger.dev says failed → recovery path
```

---

### 4.4 Deployment Tests

MiniCoder shall support non-interactive deployment validation for:

- Docker.
- Docker Compose.
- Kubernetes.

Deployment test flow:

```text
deploy stack
run migrations
seed test project
execute system scenario
verify final state
export diagnostics
tear down
```

Kubernetes should support:

- Migration Job.
- Seed Job.
- System Test Job.
- Diagnostic Export Job.
- Reconciliation Job.

---

## 5. Required Lifecycle Tools

MiniCoder shall provide CLI tools for state lifecycle management.

### 5.1 Database Lifecycle

Required commands:

```bash
minicoder db migrate
minicoder db rollback
minicoder db reset
minicoder db seed
minicoder db snapshot
minicoder db restore
minicoder db validate
minicoder db diff
minicoder db status
```

SQLite local mode:

- create
- migrate
- reset
- seed
- snapshot
- restore
- validate

PostgreSQL hosted/team mode:

- migrate
- safe rollback where supported
- seed isolated test tenant/project
- create isolated test schema/database
- export diagnostics
- restore from backup
- validate migration status

---

### 5.2 Trigger.dev Lifecycle

Required commands:

```bash
minicoder trigger deploy
minicoder trigger list-runs
minicoder trigger inspect-run
minicoder trigger cancel-run
minicoder trigger replay-run
minicoder trigger drain-queue
minicoder trigger reset-dev
minicoder trigger validate
minicoder trigger reconcile
```

MiniCoder must handle:

- stuck runs
- failed runs
- waiting runs
- cancelled runs
- duplicate runs
- replayed runs
- orphaned waitpoints
- queue backlog
- retry storms

Database records must track:

```text
triggerdev_run_id
triggerdev_task_id
triggerdev_status
last_seen_at
linked_workflow_event_id
linked_agent_run_id
linked_feature_run_id
```

---

### 5.3 Workflow State Lifecycle

Required commands:

```bash
minicoder state inspect
minicoder state validate
minicoder state reconcile
minicoder state doctor
minicoder state export-diagnostics
minicoder state repair --dry-run
```

The `doctor` command should detect:

- database/Trigger.dev mismatch
- database/GitHub mismatch
- orphaned feature runs
- orphaned waitpoints
- stale locks
- stuck human_required states
- failed outbox events
- unprocessed inbox events
- stale artifact exports
- inconsistent cost records

---

### 5.4 GitHub Simulation

Required test commands:

```bash
minicoder github simulate-pr-opened
minicoder github simulate-pr-synchronized
minicoder github simulate-check-passed
minicoder github simulate-check-failed
minicoder github simulate-review-approved
minicoder github simulate-review-requested-changes
minicoder github simulate-pr-merged
minicoder github simulate-pr-closed
```

These commands are for test and development environments only.

---

### 5.5 Test Scenario Runner

Required commands:

```bash
minicoder test unit
minicoder test integration
minicoder test system
minicoder test scenario planning-basic
minicoder test scenario clarification-required
minicoder test scenario review-loop
minicoder test scenario merge-gate
minicoder test scenario trigger-retry
minicoder test scenario github-race
minicoder test scenario final-design-document
```

The scenario runner must return non-zero exit codes on failure so it can be used in CI/CD.

---

## 6. Mock Services and Adapters

MiniCoder must provide deterministic mock implementations.

Required mock adapters:

- MockPlannerAdapter
- MockCoderAdapter
- MockReviewerAdapter
- MockArbiterAdapter
- MockDocumentationAdapter
- HumanTestAdapter

Required mock external systems:

- MockGitHubProvider
- MockTriggerRunner or Trigger.dev test harness wrapper
- MockCostProvider
- MockArtifactStorage

Mock scenarios:

- planner returns sufficient
- planner returns insufficient
- planner returns sufficient_with_assumptions
- coder succeeds
- coder fails
- coder produces invalid output
- reviewer approves
- reviewer requests changes
- reviewer repeats same finding
- arbiter resolves
- arbiter escalates
- documentation generator succeeds
- documentation generator requires revision

---

## 7. Production Safety Requirements

Destructive commands must distinguish environments.

Commands such as:

```bash
minicoder db reset
minicoder trigger reset-dev
minicoder state purge
```

must require:

- environment check
- role/permission check
- dry-run mode where possible
- backup check where applicable
- explicit confirmation flag
- audit event

Production reset should normally be disallowed.

Recommended pattern:

```bash
minicoder db reset --env development
```

Production destructive commands should fail unless specifically implemented as safe maintenance workflows.

---

## 8. CI/CD Requirements

GitHub Actions shall run:

- lint
- typecheck
- unit tests
- integration tests
- migration validation
- system test smoke scenario
- Docker build
- Docker Compose test, where applicable
- Trigger.dev task deployment validation

Longer system tests may run nightly or on release branches.

---

## 9. Kubernetes Requirements

MiniCoder shall support Kubernetes non-interactive testing via Jobs.

Required jobs:

- migration job
- seed job
- system-test job
- diagnostic-export job
- reconciliation job

Each job must:

- be runnable unattended
- emit structured logs
- exit non-zero on failure
- produce diagnostics when configured

---

## 10. Acceptance Criteria

This specification is satisfied when:

- Unit tests run without external services.
- Integration tests run with disposable databases and mocked providers.
- System tests run without real LLM calls or manual approval.
- Docker Compose system tests run non-interactively.
- Kubernetes system test jobs run non-interactively.
- Database lifecycle commands exist.
- Trigger.dev lifecycle commands exist.
- State validation and doctor commands exist.
- GitHub simulation commands exist.
- Production-destructive operations are guarded.
- CI can execute meaningful MiniCoder workflows automatically.
