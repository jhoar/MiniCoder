# MiniCoder — Combined Implementation Plan

## 1. Purpose

This document defines the implementation plan for MiniCoder.

MiniCoder has one target architecture. The implementation is phased, but there is no separate prototype system and production system.

## 2. Locked Architecture

```text
SQLite = authoritative state.
Trigger.dev = durable workflow execution.
GitHub = repository and PR truth.
GitHub Actions = CI and Trigger.dev task deployment.
Orchestrator Core = business rules, state machine, policy, database writes.
API = command/query surface.
UI = API clients.
Agents = vendor-neutral adapters.
Markdown artifacts = generated/importable snapshots.
```

## 3. Phase Overview

| Phase | Name | Outcome |
|---|---|---|
| 1 | Repository and Core Foundation | TypeScript monorepo, SQLite, migrations, core domain model |
| 2 | State Machine and Command Layer | Valid lifecycle transitions and transactional commands |
| 3 | Trigger.dev Workflow Harness | Durable workflow execution from the start |
| 4 | Agent Adapter Foundation | Vendor-neutral adapters, mock/human adapters, conformance tests |
| 5 | Bootstrap Planner, Readiness, and Clarification | Specification input becomes approved SQLite backlog |
| 6 | GitHub Integration and Reconciliation | SQLite workflow state reconciles with GitHub truth |
| 7 | Execution Orchestrator | Sequential feature execution starts |
| 8 | Reference Coder Adapter | First replaceable Coder implementation |
| 9 | Reference Reviewer Adapter and Review/Fix Loop | Structured review loop works |
| 10 | Disagreement, Arbiter, and Human Escalation | Bounded disagreement resolution |
| 11 | Merge Gate and Branch Protection | Safe policy-based merge |
| 12 | Orchestrator API | Stable command/query API |
| 13 | Ink Text UI | Developer/operator terminal UI |
| 14 | Next.js Web UI | Team-facing UI |
| 15 | Observability, Cost, and Recovery | Operational hardening |
| 16 | Final Design Document Generator | Final system design document after completion |
| 17 | Additional Adapters and Future Extensions | Provider flexibility and scale-out |

## Phase 1 — Repository and Core Foundation

Deliver a TypeScript monorepo, pnpm workspace, shared lint/type/test setup, SQLite dependency, migration framework, database access layer, core entity types, and basic CI.

Acceptance criteria: repository builds, tests run, SQLite migrations create the initial schema, core packages compile, and CI validates lint, types, and tests.

## Phase 2 — State Machine and Command Layer

Deliver planning lifecycle states, execution lifecycle states, completion/design-document states, state transition validator, command handler framework, workflow event recording, single-active-feature invariant, and transactional command execution.

Acceptance criteria: invalid transitions are rejected, valid transitions are persisted, every transition records an event, and commands are covered by unit tests.

## Phase 3 — Trigger.dev Workflow Harness

Deliver Trigger.dev project setup, local development setup, GitHub Actions deployment workflow for Trigger.dev tasks, task wrapper pattern, queue configuration, waitpoint patterns, and Trigger.dev run metadata linked to SQLite.

Initial tasks:

```text
planning-readiness-assessment
start-clarification
generate-plan
activate-backlog
start-next-feature
github-reconciliation
artifact-export
```

Task rule:

```text
Trigger.dev tasks call Orchestrator Core commands.
They do not contain business rules directly.
```

Acceptance criteria: Trigger.dev tasks can be deployed and run, a mock task updates SQLite through a core command, retry behavior is configured, and the waitpoint pattern is proven with a simulated human approval.

## Phase 4 — Agent Adapter Foundation

Deliver PlannerAgentAdapter, CoderAgentAdapter, ReviewerAgentAdapter, ArbiterAgentAdapter, DocumentationAgentAdapter, HumanAgentAdapter, adapter registry, capability model, mock adapters, human adapter, adapter run records, and adapter conformance tests.

Acceptance criteria: core does not depend on provider SDKs, mock adapters can run through Trigger.dev task wrappers, AgentRun records are created, and adapter capability validation works.

## Phase 5 — Bootstrap Planner, Readiness, and Clarification

Deliver specification input ingestion, Planning Readiness Assessment, clarification sessions, clarification questions/answers, assumption records, gap records, plan generation, feature request generation, dependency generation, acceptance criteria generation, test expectation generation, human approval, backlog activation, and plan.md/backlog.md export/import.

Acceptance criteria: sufficient input generates a draft plan, insufficient input creates clarification questions, blocking gaps prevent activation, approved plan activates features as `approved_pending_execution`, and no runtime logic reads backlog.md as source of truth.

## Phase 6 — GitHub Integration and Reconciliation

Deliver GitHub client package, branch operations, PR operations, review/check reading, mergeability reading, status check publication, reconciliation service, and GitHub link records.

Acceptance criteria: MiniCoder can detect/create branches and PRs, SQLite/GitHub mismatches are reconciled or marked `human_required`, and GitHub operations are evented.

## Phase 7 — Execution Orchestrator

Deliver select next feature command, start feature command, PR tracking, CI tracking, Trigger.dev execution flow, feature progress events, and pause/resume.

Acceptance criteria: only one feature can be active, eligible features are selected in sequence, dependencies are enforced, and mock execution progresses through the happy path.

## Phase 8 — Reference Coder Adapter

Deliver a reference Coder adapter such as CodexCoderAdapter, coder context packs, branch update handling, commit and push tracking, and coder run cost/token records.

Acceptance criteria: Coder adapter implements CoderAgentAdapter, orchestrator does not call provider APIs directly, coder run can update a branch, and changed files/commits are recorded.

## Phase 9 — Reference Reviewer Adapter and Review/Fix Loop

Deliver a reference Reviewer adapter such as ClaudeReviewerAdapter, structured review finding parser/normalizer, review/fix loop task, coder response records, and review cycle count.

Acceptance criteria: reviewer output becomes structured findings, blocking findings trigger fixes, non-blocking findings do not block merge, and review loop limits are enforced.

## Phase 10 — Disagreement, Arbiter, and Human Escalation

Deliver disagreement detection, disagreement records, Arbiter adapter integration, human-required workflow, and escalation UI/API support.

Acceptance criteria: repeated unresolved findings create disagreement records, automation stops when human_required, and human can resolve, retry, skip, block, or resume.

## Phase 11 — Merge Gate and Branch Protection

Deliver merge policy engine, review gate status check, merge-if-ready command, branch protection documentation/checks, and merge decision records.

Acceptance criteria: unsafe PRs cannot be merged by MiniCoder, safe PRs can be merged through policy, SQLite updates after merge, and next feature starts only after merge.

## Phase 12 — Orchestrator API

Deliver Fastify API, read endpoints, command endpoints, authentication local mode, role model, and API tests.

Acceptance criteria: API exposes SQLite-backed view models, API commands call core commands, no arbitrary state mutation endpoints are required, and UI can be built on the API.

## Phase 13 — Ink Text UI

Deliver dashboard, feature queue, active feature view, planning/clarification view, review findings view, agent runs view, cost view, human-required view, artifact view, and adapter view.

Acceptance criteria: TUI uses API only, triggers allowed commands, and shows Trigger.dev task/waitpoint status via API.

## Phase 14 — Next.js Web UI

Deliver dashboard, planning review, clarification workflow, feature detail, PR/review detail, disagreements, human-required queue, cost dashboard, artifact manager, adapter manager, and design document review page.

Acceptance criteria: Web UI uses API only, RBAC is enforced by backend, human approvals work, and artifact exports are visible as snapshots.

## Phase 15 — Observability, Cost, and Recovery

Deliver workflow timeline, agent run trace view, Trigger.dev run mapping, cost dashboards, budget gates, recovery commands, reconciliation commands, secret redaction checks, and optional OpenTelemetry-compatible export.

Acceptance criteria: operators can reconstruct workflow history, budgets can pause automation, recovery commands are safe and audited, and private chain-of-thought is not stored.

## Phase 16 — Final Design Document Generator

Deliver design document tables, design decision records, DocumentationAgentAdapter, Design Document Generator, Trigger.dev design-document task, final document review workflow, and final-design-document.md export.

Required sections:

1. Purpose and Scope
2. Goals and Constraints
3. System Context
4. Architecture Overview
5. Component Design
6. Data Design
7. API and Interface Design
8. Workflows and Runtime Behavior
9. Deployment and Infrastructure
10. Observability and Operations
11. Testing Strategy
12. Design Decisions
13. Glossary

Acceptance criteria: design document generation starts only after implementation completion, all 13 required sections are present, document is generated from SQLite and GitHub evidence, human can approve or request revision, and project reaches `project_complete` only after approval.

## Phase 17 — Additional Adapters and Future Extensions

Deliver additional coder adapters, additional reviewer adapters, adapter conformance suite, multi-repository planning, optional advanced RBAC, optional PDF/DOCX export, and optional self-hosted Trigger.dev support.

Acceptance criteria: at least one alternative adapter can be added without changing core orchestration, and future extensions do not change the baseline architecture.
