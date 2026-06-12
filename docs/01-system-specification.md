# MiniCoder — System Specification

> Status: Canonical
> Supersedes: minicoder_unified_system_specification.md,
> minicoder_unified_system_specification_testing_updated.md
> Version: 1.0.0
> Last-updated: 2026-06-12

Terms, state names, role/adapter names, and the CLI surface are defined in
[`00-glossary-and-terms.md`](00-glossary-and-terms.md) and are authoritative there.

## 1. Purpose

MiniCoder is an agentic software development orchestration system. It converts user intent or
system specifications into a clarified, approved, sequential implementation backlog, then
coordinates implementation through feature branches, pull requests, structured reviews, fixes,
merge gates, and final documentation.

MiniCoder is designed to be auditable, deterministic, cost-aware, safe, and **fully testable
without human intervention**.

## 2. Scope

MiniCoder includes Bootstrap planning, planning readiness assessment, clarification workflow,
structured implementation plan generation, database-backed feature backlog, sequential feature
execution, vendor-neutral agent adapters, GitHub branch and pull request workflow (webhook-driven
with reconciliation fallback), structured review/fix loops, disagreement and human escalation,
durable Workflow Layer execution, automated testing and state-lifecycle tooling, cost
management, observability and audit records, the Orchestrator API, a Node.js + Ink Text UI, a
React / Next.js Web UI, Markdown artifact import/export, and final System Design Document
generation.

MiniCoder does **not** initially include parallel feature execution, SCM providers other than
GitHub, multi-repository orchestration, PDF/DOCX exports, a plugin marketplace, or advanced
enterprise RBAC. These are future extensions, not separate architectures.

> Note: **PostgreSQL is in scope** as the hosted/team state store (see §3, §14). It is not a
> deferred "migration"; it is a first-class deployment profile supported by the persistence
> abstraction from Phase 1.

## 3. One Architecture, Multiple Deployment Profiles

MiniCoder has one target architecture. There is no separate "prototype system" and "production
system." The implementation is phased, but the architecture is fixed.

```text
MiniCoder database = authoritative planning, backlog, workflow, testing, review, event,
                     agent-run, cost, artifact, and design-document state.
Workflow Layer     = durable workflow execution (tasks, retries, queues, schedules,
                     waitpoints, resumability); implemented by Trigger.dev.
GitHub             = authoritative repository, branch, commit, PR, review, CI/check,
                     conversation, mergeability, and merge state.
GitHub webhooks    = primary source for external GitHub changes.
Scheduled reconciliation = fallback/repair mechanism.
GitHub Actions     = CI, tests, build validation, and deployment of Trigger.dev tasks.
Orchestrator Core  = state machine, command handlers, policy checks, merge gates, database
                     writes, idempotency, and reconciliation.
Orchestrator API   = safe command and query interface.
UI                 = API clients only.
Agents             = invoked through vendor-neutral role-based adapters.
plan.md / backlog.md / final-design-document.md = generated/importable artifacts, not runtime state.
Sequential execution = policy setting, not schema limitation.
Private chain-of-thought = not stored.
Testing            = fully automated by default across unit, integration, system, Docker Compose,
                     and Kubernetes deployments.
State lifecycle tooling = required for database, Workflow Layer, GitHub simulation, agent runs,
                     artifacts, and diagnostics.
```

The state store and the Trigger.dev execution backend are independent deployment axes (see §14 and
[`00-glossary-and-terms.md`](00-glossary-and-terms.md) §6). The default Trigger.dev backend is
**self-hosted single-node**; HA-cluster self-hosting and Trigger.dev Cloud are drop-in options.

### 3.1 Local / Single-Node Profile

- SQLite on local disk.
- Trigger.dev backend: default self-hosted single-node (see §14).
- GitHub repository.
- Local API, local TUI, optional local Web UI.

### 3.2 Hosted / Team Profile

- PostgreSQL.
- Trigger.dev backend: self-hosted single-node, self-hosted HA cluster, or Cloud (see §14).
- Hosted API, Web UI.
- GitHub OAuth (or equivalent) and GitHub webhooks.

### 3.3 Explicit SQLite Limitation

SQLite shall not be used over network filesystems, shared persistent volumes, or network-mounted
database files. PostgreSQL is required for hosted/team deployments.

## 4. Core Design Principles

### 4.1 Database-Authoritative State

The MiniCoder database is authoritative for system state from the beginning, accessed through a
**persistence abstraction** that supports SQLite (local/single-node) and PostgreSQL (hosted/team).
No runtime orchestration logic shall depend on parsing `backlog.md`.

### 4.2 Workflow Layer From the Start

MiniCoder uses a durable Workflow Layer (implemented by Trigger.dev) from the early implementation
phases. The Workflow Layer owns durable task execution, retries, queues, schedules, waitpoints, and
resumable long-running workflows. It does **not** own domain state, state-machine rules,
merge policy, agent contracts, business logic, or GitHub truth. Workflow Layer tasks are thin,
idempotent wrappers that call Orchestrator Core commands. Because of this, the execution backend
(self-hosted single-node by default, self-hosted HA cluster, or Cloud) is a deployment choice;
switching between backends requires no architectural change (see §14).

### 4.3 GitHub as Repository Truth (webhook-driven)

GitHub is authoritative for branches, commits, pull requests, reviews, comments, CI/check status,
conversation resolution, mergeability, and merge result. **GitHub webhooks are the primary source
for external GitHub changes; scheduled reconciliation is a fallback and repair mechanism.** Before
expensive agent calls, MiniCoder performs pre-flight GitHub and database checks. SQLite/PostgreSQL
is authoritative for orchestration intent, history, and policy decisions; MiniCoder reconciles its
database state against GitHub state.

### 4.4 Vendor-Neutral Agents

MiniCoder integrates agents through role-based adapters. The core system must not depend on Codex,
Claude, Copilot, Cursor, Aider, OpenHands, or any other specific product. Reference adapters may
include Codex and Claude implementations, but they are not architectural dependencies.

### 4.5 Command-Based Orchestration

All state-changing operations go through commands. Prefer `POST /actions/merge-if-ready`; avoid
arbitrary status mutation such as `PATCH /features/FR-002 { "status": "merged" }`.

### 4.6 No Chain-of-Thought Storage

MiniCoder must not request, capture, store, or expose private model chain-of-thought. It may store
context-pack references, prompt-template versions, visible outputs where policy allows, tool calls,
diffs or references, test excerpts, structured findings, decision summaries, evidence references,
token/cost records, policy decisions, and error summaries.

### 4.7 Sequential Execution by Policy

MiniCoder executes one feature request at a time. This is a **policy setting enforced via workflow
locks/leases and execution lanes, not a schema limitation.** A future parallel-execution feature
may relax the policy without a schema change.

### 4.8 Human Approval for Irreversible or Risky Steps

Human approval is required for activating generated backlogs, accepting unresolved planning
assumptions, budget overrides, review-loop limit overrides, ambiguous feature resolution,
human-required recovery, and final design document approval. Automated tests simulate these human
actions (see [`04-testing-validation-state-lifecycle.md`](04-testing-validation-state-lifecycle.md)).

## 5. Major Subsystems

### 5.1 Bootstrap Planner
Converts user input or specifications into a structured implementation plan and feature requests,
writing structured records to the database. It does not produce the executable backlog by writing
`backlog.md`. Detailed in [`02-bootstrap-planner-clarification.md`](02-bootstrap-planner-clarification.md).

### 5.2 Planning Readiness Assessment
Before generating an executable backlog, the planner performs a readiness assessment with statuses
`sufficient`, `sufficient_with_assumptions`, `insufficient`. It identifies blocking gaps,
non-blocking gaps, assumptions, clarification questions, readiness score, and backlog-generation
eligibility. Blocking gaps prevent backlog activation unless resolved or explicitly accepted by an
authorized human.

### 5.3 Clarification Workflow
The structured dialogue that resolves missing, ambiguous, or risky requirements before backlog
generation or activation. Includes sessions, questions, answers, gaps, assumptions, decisions, and
score. Statuses are defined in the glossary §3.6. If blocking gaps remain after clarification,
MiniCoder must not activate an executable backlog unless an authorized human explicitly accepts the
risk.

### 5.4 Execution Orchestrator
Selects approved feature requests and moves them through the controlled execution lifecycle. Owns
feature selection, state-transition validation, GitHub reconciliation, agent-invocation
coordination, review/fix loop control, merge-gate evaluation, human escalation, and
implementation-complete detection.

### 5.5 Workflow Layer
The Workflow Layer (implemented by Trigger.dev) executes durable workflows and idempotent tasks.
Task families include planning readiness assessment, clarification, plan generation, backlog
activation, start next feature, coder run, reviewer run, review/fix loop, disagreement resolution,
merge gate, GitHub reconciliation, webhook inbox processing, artifact export, cost recalculation,
and final design document generation. Workflow Layer run IDs and run metadata (Trigger.dev run
metadata) are correlated to database workflow events and agent runs.

### 5.6 Agent Adapter Architecture
Role-based adapters: `PlannerAgentAdapter`, `CoderAgentAdapter`, `ReviewerAgentAdapter`,
`ArbiterAgentAdapter`, `DocumentationAgentAdapter`, `HumanAgentAdapter`. Adapters declare
capabilities, normalize outputs, normalize errors, and record agent runs. Detailed in
[`03-agent-adapter-architecture.md`](03-agent-adapter-architecture.md).

### 5.7 GitHub Integration
Owns all GitHub API operations and the webhook receiver: repository inspection, branch
lookup/creation, PR lookup/creation, PR state reading, review reading, check/status reading,
mergeability reading, status check publication, webhook ingestion into the inbox, and the merge
operation when policy permits.

### 5.8 Review/Fix Loop Controller
Manages structured review cycles between Coder and Reviewer agents. Loops are bounded. Default
limits: five review cycles per feature, two fix attempts per finding, one reopening of the same
finding.

### 5.9 Disagreement Manager
Detects unresolved or circular coder/reviewer conflicts and routes them to the Arbiter or Human
Agent.

### 5.10 Merge Gate
Evaluates whether a PR may be merged and publishes `agent-orchestrator/review-gate`. Merge is
allowed only when all policy and GitHub conditions pass (see §12).

### 5.11 Cost Manager
Tracks and enforces budgets by project, feature, agent run, role, adapter, provider, model, and
review cycle. Budget overruns can pause automation or require human approval.

### 5.12 Observability and Event System
Records workflow events, agent runs, tool operations, GitHub operations, review findings, coder
responses, disagreements, policy decisions, cost records, human approvals, outbox/inbox events, and
Workflow Layer run references.

### 5.13 Orchestrator API
Exposes read models and commands. Only supported access path for TUI and Web UI.

### 5.14 Text UI
Node.js + Ink. Supports developer/operator workflows. Detailed in
[`05-ui-specification.md`](05-ui-specification.md).

### 5.15 Web UI
React / Next.js. Supports team visibility, approvals, cost dashboards, artifact management,
state-health/admin views, and human-required workflows.

### 5.16 Artifact Generator
Exports `plan.md`, `backlog.md`, `final-design-document.md` (and optional future PDF/DOCX).
Artifacts are generated from database and source repository state.

### 5.17 Design Document Generator
Produces the final System Design Document after implementation completion. Triggered by the
Execution Orchestrator once all approved features are merged and final validation passes. May use a
`DocumentationAgentAdapter` to draft content. A human must approve the final document before
`project_complete`.

## 6. Persistence and Consistency

MiniCoder uses a persistence abstraction supporting SQLite (local/single-node) and PostgreSQL
(hosted/team). Required consistency patterns:

- idempotency keys
- optimistic concurrency / version columns
- outbox events
- inbox / webhook events
- workflow locks / leases
- execution lanes
- scheduled reconciliation
- state doctor tooling

Sequential execution is enforced by policy (locks/lanes), not schema.

## 7. Lifecycle Model

The canonical state lists (planning, execution, failure/escalation, completion/design-document,
readiness, clarification) are defined once in [`00-glossary-and-terms.md`](00-glossary-and-terms.md)
§3. Subsystems must use those names.

## 8. Data Design

MiniCoder stores authoritative system state in its database (SQLite or PostgreSQL). Core table
groups:

- **Project and repository:** `projects`, `repositories`, `github_links`
- **Planning:** `specification_inputs`, `planning_readiness_assessments`, `planning_gaps`,
  `planning_questions`, `planning_assumptions`, `clarification_sessions`, `clarification_questions`,
  `clarification_answers`, `clarification_decisions`, `implementation_plans`, `plan_sections`,
  `feature_requests`, `feature_dependencies`, `acceptance_criteria`, `test_expectations`
- **Workflow:** `workflow_states`, `workflow_events`, `human_approvals`, `policy_decisions`
- **Consistency / durability:** `idempotency_keys`, `outbox_events`, `inbox_events`
  (GitHub webhook events), `workflow_locks` (locks/leases for sequential execution),
  `triggerdev_runs` (correlation: `triggerdev_run_id`, `triggerdev_task_id`, `triggerdev_status`,
  `last_seen_at`, `linked_workflow_event_id`, `linked_agent_run_id`, `linked_feature_run_id`)
- **Agents:** `agent_adapters`, `agent_capabilities`, `agent_configurations`, `agent_runs`,
  `agent_errors`, `agent_tool_operations`, `agent_context_packs`, `adapter_conformance_results`
- **Review and disagreement:** `review_findings`, `coder_responses`, `disagreement_records`
- **Cost and observability:** `cost_records`
- **Artifacts and design documents:** `artifact_exports`, `design_documents`,
  `design_document_sections`, `design_decisions`, `glossary_terms`

## 9. API Design

The Orchestrator API exposes read endpoints, command endpoints, and webhook endpoints.

**Read endpoint groups:** projects, repositories, specification inputs, planning readiness,
clarification sessions, implementation plans, features, active feature, GitHub links, pull
requests, review findings, disagreements, agent runs, workflow events, policy decisions, costs,
budgets, artifacts, design documents, agent adapters, agent configuration, status, and **state
health / diagnostics** (state-doctor results, failed outbox/inbox events, stuck Trigger.dev runs,
stale workflow locks, test/scenario results, environment mode).

**Command endpoint groups:** ingest specification, assess planning readiness, start clarification,
answer clarification question, complete clarification, generate plan, approve plan, activate
backlog, start next feature, request coder run, request review, request fixes, reconcile state,
recompute merge gate, merge if ready, resolve disagreement, approve budget override, pause, resume,
export plan, export backlog, generate final design document, approve final design document, and the
state/diagnostics actions (validate, reconcile, doctor, export-diagnostics) subject to
authorization.

**Webhook endpoints:** receive GitHub webhook deliveries, verify signatures, and persist them to
the inbox for durable processing (reconciliation remains the fallback path).

## 10. Agent Adapter Contracts

Summarized here; full contracts in [`03-agent-adapter-architecture.md`](03-agent-adapter-architecture.md).

- `PlannerAgentAdapter` — readiness assessments, clarification prompts, implementation plans,
  feature requests.
- `CoderAgentAdapter` — implements approved feature requests on assigned branches; never merges.
- `ReviewerAgentAdapter` — reviews PRs and returns structured findings.
- `ArbiterAgentAdapter` — resolves structured disagreements.
- `DocumentationAgentAdapter` — drafts the final System Design Document from structured records and
  repository evidence; does not decide completion.
- `HumanAgentAdapter` — manual approval, fallback, and human-required decisions.

## 11. Review Finding Model

Each review finding includes finding ID, feature request ID, pull request number, severity,
category, file, line, evidence, required action, acceptance-criteria reference, policy reference,
and status. Severities are defined in glossary §3.7; only `blocking` findings prevent merge.

## 12. Merge Policy

A pull request may be merged only when it belongs to the active feature, targets the correct base
branch, matches the database branch record, CI checks pass, no unresolved blocking findings remain,
required conversations are resolved, review-cycle limits are not exceeded, the PR is mergeable, no
blocking labels exist, budget gates pass, required human approvals exist, and GitHub branch
protection permits merge.

## 13. Final System Design Document

After all approved features are merged and final validation passes, MiniCoder generates a final
System Design Document with exactly these top-level sections:

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

Responsibility split:

- Execution Orchestrator decides when generation is allowed.
- Design Document Generator collects evidence and assembles document structure.
- DocumentationAgentAdapter drafts natural-language content where configured.
- Artifact Generator exports `final-design-document.md` and optional future formats.
- Human Approver approves or requests revision before `project_complete`.

## 14. Deployment Model

One architecture, with two independent deployment axes — the **state store** and the **Trigger.dev
execution backend** — each chosen without architectural change.

**State store:** SQLite (local/single-node) or PostgreSQL (hosted/team), per §3.1–§3.2.

**Trigger.dev execution backend** (three swappable tiers):

- **Self-host, single-node — DEFAULT.** Trigger.dev webapp + Postgres + Redis + worker on one host
  (Docker Compose). Low availability / single point of failure; simplest to operate; keeps task
  payloads inside the user's boundary.
- **Self-host, HA cluster — option.** Clustered Postgres/Redis and multiple workers for redundancy
  and scale; an infrastructure/ops change only.
- **Trigger.dev Cloud — option.** Managed SaaS; no infrastructure to run.

All tiers share the same SDK, task contracts, queues, schedules, waitpoints, and run metadata, so
switching backends is a deployment/configuration decision, not an architecture change.

## 15. Security

MiniCoder must scope provider credentials by adapter, avoid exposing all provider tokens to the
orchestrator where not required, redact secrets, avoid storing secrets in the database, avoid
writing secrets to Markdown artifacts, avoid storing private chain-of-thought, verify GitHub
webhook signatures, use least-privilege GitHub tokens, and avoid secret-bearing workflows on
untrusted fork code.

## 16. Technology Stack and Future Extensions

The locked technology stack is defined in [`00-glossary-and-terms.md`](00-glossary-and-terms.md) §7.

Explicitly deferred future extensions: parallel feature execution, multi-SCM support, multiple
active repositories, advanced enterprise RBAC, PDF/DOCX export, and a plugin marketplace. These are
future features, not alternate initial architectures. (The Trigger.dev execution backend is a
deployment axis, not a deferred extension — see §14.)
