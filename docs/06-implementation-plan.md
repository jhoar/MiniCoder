# MiniCoder — Implementation Plan

> Status: Canonical
> Supersedes: minicoder_combined_implementation_plan.md,
> minicoder_combined_implementation_plan_testing_updated.md
> Version: 1.0.0
> Last-updated: 2026-06-12

This is the single canonical phase plan (18 phases). State names, adapter names, and the CLI
surface are defined in [`00-glossary-and-terms.md`](00-glossary-and-terms.md); architecture is
defined in [`01-system-specification.md`](01-system-specification.md).

## 1. Purpose

MiniCoder has one target architecture with local/single-node and hosted/team deployment profiles.
The implementation is phased, but there is no separate prototype system and production system.
Automated testing and state-lifecycle management are foundational requirements (Phase 4), not an
afterthought.

## 2. Phase Overview

| Phase | Name | Outcome |
|---|---|---|
| 1 | Repository and Persistence Foundation | Monorepo; persistence abstraction; SQLite + PostgreSQL; migrations; core domain model |
| 2 | State Machine, Idempotency, and Command Layer | Valid lifecycle transitions; transactional, idempotent commands; outbox/inbox; locks/lanes |
| 3 | Workflow Layer Harness | Durable workflow execution from the start |
| 4 | Test Harness and State Lifecycle Tooling | Automated test modes and lifecycle CLI commands |
| 5 | Agent Adapter Foundation | Vendor-neutral adapters, mock/human adapters, conformance tests |
| 6 | Bootstrap Planner, Readiness, and Clarification | Specification input becomes an approved database backlog |
| 7 | GitHub Webhooks, Integration, and Reconciliation | Event-driven GitHub sync with reconciliation fallback |
| 8 | Execution Orchestrator | Sequential, policy-driven feature execution |
| 9 | Reference Coder Adapter | First replaceable Coder implementation |
| 10 | Reference Reviewer Adapter and Review/Fix Loop | Structured review loop |
| 11 | Disagreement, Arbiter, and Human Escalation | Bounded disagreement resolution |
| 12 | Merge Gate and Branch Protection | Safe, policy-based merge |
| 13 | Orchestrator API | Stable command/query/webhook API |
| 14 | Ink Text UI | Developer/operator terminal UI |
| 15 | Next.js Web UI | Team-facing UI |
| 16 | Observability, Cost, and Recovery | Operational hardening |
| 17 | Final Design Document Generator | Final system design document after completion |
| 18 | Future Extensions | Parallel execution, multi-repo, additional adapters/SCM, PDF/DOCX |

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
supported; migrations create the initial schema; the ERD matches the migrations; secrets resolve
only through the backend abstraction (no plaintext at rest); no SQLite network-storage assumption
exists; CI validates lint, types, and tests.

## Phase 2 — State Machine, Idempotency, and Command Layer

Deliver planning/execution/completion lifecycle states, the **full state-transition matrix**
(glossary §3.9 columns), a state-transition validator, a command handler framework, transactional
command execution, workflow event recording, idempotency keys, outbox/inbox tables, an outbox/inbox
dispatcher (scheduled Workflow Layer task or background worker), workflow locks/leases, execution
lanes, and **audit actor identity + local auth + secret-redaction tests** (security foundation,
continued from Phase 1).

Acceptance: invalid transitions are rejected; valid transitions are persisted and evented; the
implemented transitions match the matrix; commands are idempotent and unit-tested; outbox/inbox
records are drained with at-least-once, idempotent dispatch; secret redaction is test-covered;
**sequential execution is enforced by policy (locks/lanes), not by a schema invariant**.

## Phase 3 — Workflow Layer Harness

Deliver Trigger.dev project setup with **self-hosted single-node as the default backend** (Docker
Compose: webapp + Postgres + Redis + worker), a GitHub Actions deployment workflow for Trigger.dev
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

These names use the canonical tokens defined in
[`02-bootstrap-planner-clarification.md`](02-bootstrap-planner-clarification.md) §6; the remaining
planner tasks (ingest, record-answer, complete-clarification, validate-backlog, request-approval,
import-backlog) arrive with Phase 6.

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

## Phase 4 — Test Harness and State Lifecycle Tooling

Deliver the unit/integration/system test harness, mock adapters, a mock GitHub provider, a
Trigger.dev test-harness wrapper, the database lifecycle CLI, the Trigger.dev lifecycle CLI, the
state doctor, GitHub event simulation, the scenario runner, a Docker Compose test flow, and
Kubernetes Job test templates. The full CLI surface is defined in
[`00-glossary-and-terms.md`](00-glossary-and-terms.md) §5; behaviors are specified in
[`04-testing-validation-state-lifecycle.md`](04-testing-validation-state-lifecycle.md).

Acceptance: system tests run without real LLM calls; a Docker Compose scenario runs unattended;
destructive commands are guarded; CI can run a system smoke scenario.

## Phase 5 — Agent Adapter Foundation

Deliver the six role interfaces, an adapter registry, the capability model, the mock adapters and
`HumanTestAdapter`, adapter run records, and adapter conformance tests (see
[`03-agent-adapter-architecture.md`](03-agent-adapter-architecture.md)).

Acceptance: core does not depend on provider SDKs; mock adapters run through Workflow Layer task
wrappers; `agent_runs` records are created; capability validation works.

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
key, GitHub App permissions, branch naming, PR labels, the `agent-orchestrator/review-gate` status
check, merge method, force-push policy, and the reconciliation algorithm — see
[`01-system-specification.md`](01-system-specification.md) §5.7).

Acceptance: webhook deliveries are persisted to the inbox and processed durably; MiniCoder can
detect/create branches and PRs; database/GitHub mismatches are reconciled or marked `human_required`;
GitHub operations are evented.

## Phase 8 — Execution Orchestrator

Deliver the select-next-feature and start-feature commands, active-feature run records, PR/CI
tracking, the Workflow Layer execution flow, feature-progress events, sequential policy enforcement,
and pause/resume.

Acceptance: only one feature is active at a time (by policy); eligible features are selected in
sequence; dependencies are enforced; mock execution progresses through the happy path.

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

Deliver the merge-policy engine, the `agent-orchestrator/review-gate` status check, the
merge-if-ready command, branch-protection documentation/checks, and structured
**`merge_gate_evaluations`** evidence records (CI/review/findings/conversation/branch-protection/
budget/human-approval inputs + final decision — see [`01-system-specification.md`](01-system-specification.md) §12).

Acceptance: unsafe PRs cannot be merged by MiniCoder; safe PRs merge through policy; every gate run
writes an evidence record; the database updates after merge; the next feature starts only after
merge.

## Phase 13 — Orchestrator API

Deliver the Fastify API: read endpoints, command endpoints, **webhook endpoints**, state/diagnostics
read models, local-mode authentication, a role model, the **full per-command contract** (§9), and an
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
budget gates, recovery/reconciliation commands, secret-redaction checks, and optional
OpenTelemetry-compatible export.

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
adapters and the adapter conformance suite, additional SCM providers, optional advanced RBAC, and
optional PDF/DOCX export. (Trigger.dev backend tiers — self-host single-node default, self-host HA
cluster, Cloud — are a Phase 3 deployment concern, not a deferred extension.)

Acceptance: at least one alternative adapter can be added without changing core orchestration; future
extensions do not change the baseline architecture.
