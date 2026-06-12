# MiniCoder — Glossary, Terms, and Canonical Vocabulary

> Status: Canonical
> Supersedes: (new — extracted as the single source of shared vocabulary)
> Version: 1.0.0
> Last-updated: 2026-06-12

This document is the single source of truth for state names, role names, adapter names, and the
CLI surface. Other canonical documents reference these terms; if a term appears elsewhere it must
match this file.

---

## 1. System Identity

- **MiniCoder** — Agentic Software Development Orchestration System.
- It converts user intent or system specifications into a clarified, approved, sequential
  implementation backlog, then orchestrates feature-branch development, pull requests, structured
  reviews, fixes, merge gates, and final design documentation.

Subsystem names:

- MiniCoder Bootstrap Planner
- MiniCoder Clarification Workflow
- MiniCoder Execution Orchestrator
- MiniCoder Agent Adapter Architecture
- MiniCoder Workflow Layer (implemented by Trigger.dev)
- MiniCoder GitHub Integration
- MiniCoder Orchestrator API
- MiniCoder Text UI
- MiniCoder Web UI
- MiniCoder Design Document Generator

---

## 2. Authority Boundaries (canonical)

```text
MiniCoder database = authoritative planning, backlog, workflow, testing, review, event,
                     agent-run, cost, artifact, and design-document state.
                     Local/single-node = SQLite on local disk. Hosted/team = PostgreSQL.
GitHub             = authoritative repository, branch, commit, PR, review, CI/check,
                     conversation, mergeability, and merge state.
GitHub webhooks    = PRIMARY source for external GitHub changes.
Scheduled reconciliation = fallback/repair mechanism.
Workflow Layer     = durable workflow execution (tasks, retries, queues, schedules, waitpoints,
                     resumability); implemented by Trigger.dev, which is authoritative only for
                     task-execution run metadata (correlated via run IDs).
Orchestrator Core  = state machine, command handlers, policy checks, merge gates, database writes,
                     idempotency, and reconciliation.
Orchestrator API   = the only supported access path for the UIs.
Markdown artifacts = plan.md / backlog.md / final-design-document.md — generated/importable
                     snapshots, never runtime state.
```

Foundational rules:

- **Sequential execution is a policy setting, not a schema limitation.** It is enforced via
  workflow locks/leases and execution lanes, not a hard schema invariant.
- **Private chain-of-thought is never requested, captured, stored, or exposed.**
- **SQLite is never used over a network filesystem, shared persistent volume, or
  network-mounted database file.** Hosted/team deployments use PostgreSQL.

---

## 3. Lifecycle States (canonical, single list)

### 3.1 Planning lifecycle

```text
draft → pending_approval → approved → activated_for_execution
```

- `activated_for_execution` is the terminal planning state. Activation writes each generated
  feature request into the execution lifecycle at `approved_pending_execution` (see §3.2). The two
  names describe different entities: `activated_for_execution` is a *plan* state;
  `approved_pending_execution` is the entry *feature* state.

### 3.2 Execution lifecycle (per feature request)

```text
approved_pending_execution → selected → coding → code_pushed → pr_opened → ci_running
→ under_review → changes_requested → fixing → code_pushed → under_review
→ approved_by_policy → merge_ready → merged
```

### 3.3 Failure / escalation states

```text
blocked
failed
human_required
```

### 3.4 Completion and design-document states

```text
implementation_complete
design_document_generating
design_document_ready_for_review
design_document_revision_requested
design_document_approved
project_complete
```

### 3.5 Readiness statuses

```text
sufficient
sufficient_with_assumptions
insufficient
```

### 3.6 Clarification statuses

```text
clarification_not_required
clarification_required
clarification_in_progress
clarification_complete
clarification_blocked
```

### 3.7 Review finding severities

```text
blocking            (only this severity prevents merge)
non_blocking
question
nit
out_of_scope
requires_human_decision
```

---

## 4. Agent Roles and Adapters (canonical names)

### 4.1 Roles (interfaces)

- `PlannerAgentAdapter`
- `CoderAgentAdapter`
- `ReviewerAgentAdapter`
- `ArbiterAgentAdapter`
- `DocumentationAgentAdapter`
- `HumanAgentAdapter` — represents real manual approval / fallback / human-required decisions.

### 4.2 Deterministic mocks (test implementations)

- `MockPlannerAdapter`
- `MockCoderAdapter`
- `MockReviewerAdapter`
- `MockArbiterAdapter`
- `MockDocumentationAdapter`
- `HumanTestAdapter` — the deterministic test mock of `HumanAgentAdapter`.

### 4.3 Reference (provider) adapters

`GenericLLMPlannerAdapter`, `CodexCoderAdapter`, `ClaudeReviewerAdapter`,
`GenericLLMDocumentationAdapter`. Reference implementations only — never architectural dependencies.

---

## 5. Canonical CLI Surface

Superset of all lifecycle/test tooling. Subsystem docs reference these; none introduce commands
absent here.

```bash
# Database lifecycle
minicoder db migrate
minicoder db rollback
minicoder db reset
minicoder db seed
minicoder db snapshot
minicoder db restore
minicoder db validate
minicoder db diff
minicoder db status

# Trigger.dev lifecycle
minicoder trigger deploy
minicoder trigger list-runs
minicoder trigger inspect-run
minicoder trigger cancel-run
minicoder trigger replay-run
minicoder trigger drain-queue
minicoder trigger reset-dev
minicoder trigger validate
minicoder trigger reconcile

# Workflow / state lifecycle
minicoder state inspect
minicoder state validate
minicoder state reconcile
minicoder state doctor
minicoder state export-diagnostics
minicoder state repair --dry-run

# GitHub simulation (test/dev only)
minicoder github simulate-pr-opened
minicoder github simulate-pr-synchronized
minicoder github simulate-check-passed
minicoder github simulate-check-failed
minicoder github simulate-review-approved
minicoder github simulate-review-requested-changes
minicoder github simulate-pr-merged
minicoder github simulate-pr-closed

# Test scenario runner (non-zero exit on failure)
minicoder test unit
minicoder test integration
minicoder test system
minicoder test scenario planning-basic
minicoder test scenario clarification-required
minicoder test scenario backlog-activation
minicoder test scenario review-loop
minicoder test scenario merge-gate
minicoder test scenario trigger-retry
minicoder test scenario github-race
minicoder test scenario final-design-document
```

Destructive commands (`db reset`, `trigger reset-dev`, `state purge`/`state repair`) require an
environment check, role/permission check, dry-run where possible, explicit confirmation flag, and
an audit event. Production destructive operations are disallowed unless implemented as guarded
safe-maintenance workflows.

---

## 6. Deployment Profiles

Deployment has **two independent axes**: the **state store** and the **Trigger.dev execution
backend**. Either can be chosen without architectural change, because the persistence abstraction
and the thin, idempotent task wrappers isolate these choices from domain logic.

### 6.1 State store

- **Local / Single-Node** — SQLite on local disk; local API; local TUI; optional local Web UI.
- **Hosted / Team** — PostgreSQL; hosted API; Web UI; GitHub OAuth; GitHub webhooks.

### 6.2 Trigger.dev execution backend (default: self-host single-node)

- **Self-host, single-node (DEFAULT)** — Trigger.dev webapp + Postgres + Redis + worker on one host
  (Docker Compose). Low availability (single point of failure); simplest to operate; keeps task
  payloads inside the user's boundary. Pairs naturally with the local/single-node state store.
- **Self-host, HA cluster (option)** — clustered Postgres/Redis and multiple workers for redundancy
  and scale. Same SDK and task contracts; an infrastructure/ops change only.
- **Trigger.dev Cloud (option)** — managed SaaS; no infrastructure to run.

All three tiers expose the same SDK, task contracts, queues, schedules, waitpoints, and run
metadata. **Switching backends is a deployment/configuration decision, never an architectural
change.**

---

## 7. Technology Stack (locked)

```text
Language:          TypeScript
Runtime:           Node.js
Package manager:   pnpm
Local/single-node DB: SQLite
Hosted/team DB:    PostgreSQL
Validation:        Zod
Testing:           Vitest
GitHub API:        Octokit
Workflow execution: Trigger.dev
API framework:     Fastify
Text UI:           Ink
Web UI:            React / Next.js
```
