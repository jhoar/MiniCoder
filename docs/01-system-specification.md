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
expensive agent calls, MiniCoder performs pre-flight GitHub and database checks. These include a
**capacity pre-flight**: before pulling a feature out of `approved_pending_execution`, the
Orchestrator Core queries the remaining GitHub API rate limit (via Octokit) and the configured
agent-provider token/quota limits, and defers the start — without stranding a branch mid-workflow —
when remaining capacity is insufficient. SQLite/PostgreSQL is authoritative for orchestration
intent, history, and policy decisions; MiniCoder reconciles its database state against GitHub state.

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

**GitHub integration contract** (full specification authored in implementation Phase 7):

- **Webhook events consumed:** `pull_request`, `pull_request_review`,
  `pull_request_review_comment`, `check_suite`, `check_run`, `status`, `push`. Each delivery is
  persisted to `inbox_events` keyed by a **dedup key** = GitHub delivery GUID (`X-GitHub-Delivery`),
  with idempotent processing.
- **Auth model:** a **GitHub App** (installation token, least-privilege) is preferred over a PAT;
  required permissions: contents (read/write), pull requests (read/write), checks (read/write),
  statuses (read/write), metadata (read), webhooks. See `07-security-and-secrets.md`.
- **Branch naming:** `minicoder/<feature-request-id>` (e.g., `minicoder/FR-002`); one branch per
  feature, owned by the active Coder run.
- **PR labels / status check:** MiniCoder publishes the status check `minicoder/review-gate`;
  blocking labels prevent merge (see §12).
- **Merge method:** squash by default (configurable); **force-push to MiniCoder branches is
  disallowed** once a PR is open.
- **Reconciliation algorithm:** on each relevant webhook (or on the scheduled fallback), fetch
  authoritative GitHub state, compare against the database record, and either advance the workflow,
  mark it `human_required` on irreconcilable divergence, or no-op when already consistent.

### 5.8 Review/Fix Loop Controller

Manages structured review cycles between Coder and Reviewer agents. Loops are bounded. Default
limits: five review cycles per feature, two fix attempts per finding, one reopening of the same
finding.

### 5.9 Disagreement Manager

Detects unresolved or circular coder/reviewer conflicts and routes them to the Arbiter or Human
Agent.

### 5.10 Merge Gate

Evaluates whether a PR may be merged and publishes `minicoder/review-gate`. Merge is
allowed only when all policy and GitHub conditions pass (see §12).

### 5.11 Cost Manager

Tracks and enforces budgets by project, feature, agent run, role, adapter, provider, model, and
review cycle.

**Cost/budget policy:**

- **Scopes:** budgets may be set per project, per feature, and per review cycle.
- **Soft vs. hard limits:** crossing a **soft** limit moves automation to
  `waiting_for_budget_approval` (glossary §3.8) and requires a human budget-override approval;
  crossing a **hard** limit moves it to `paused_budget_exceeded` and halts automation.
- **Resume:** an approved override (or human resume) returns automation to `running`; the
  resumption itself is recorded as a `resumed` event / `policy_decision`, not a durable state
  (glossary §3.8).
- **Forecast before run:** before an expensive agent run, the Cost Manager estimates the run cost
  and refuses to start (deferring, not stranding the branch) when the forecast would breach a hard
  limit — complementing the capacity pre-flight in §4.3.
- **Per-`AgentRun` pre-flight cap:** every `AgentRun` carries a pre-flight **token/cost cap**;
  enforcement is prospective (before the call), not only retrospective.
- **Review/fix-loop circuit breaker:** the iterative `CoderAgentAdapter` ↔ `ReviewerAgentAdapter`
  loop is a budget scope. When its cumulative cost crosses the feature's soft/hard threshold, the
  Cost Manager trips a circuit breaker — pausing to `waiting_for_budget_approval` (soft) or
  `paused_budget_exceeded` (hard) and escalating to the user for budget authorization — independent
  of the §5.8 review-cycle count limit.
- Every enforcement decision is recorded as a `policy_decision` and a `cost_record`.

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
- workflow locks / leases (with fencing tokens)
- execution lanes
- scheduled reconciliation
- state doctor tooling

**Lock fencing.** Each `workflow_locks` row carries a monotonically increasing **fence (fencing
token)** assigned at acquisition. Every core write guarded by a lock includes the fence held at
acquisition, and the persistence layer **rejects writes with a stale fence**. Lease expiry alone is
insufficient under multi-worker (HA-cluster) backends: it prevents a paused, expired-lease worker
from resuming and writing after a new holder has acquired the lock (zombie double-act).

**Outbox/inbox draining.** The **default** drainer is a dedicated **scheduled Workflow Layer sweep**
(a Trigger.dev scheduled task) that polls pending records with a **deterministic backoff** and
dispatches them with at-least-once delivery and idempotent handling; a persistent background worker
is an allowed alternative. Draining **must not** rely on database write-ahead-log (WAL) tailing or
other engine-specific change streams, to stay portable across SQLite and PostgreSQL. This preserves
transactional integrity between a database write and its downstream effects (event publication,
webhook/inbox processing). Drain progress is observable, and stuck or failed records are surfaced
and recoverable via state-doctor tooling.

Each `outbox_events` / `inbox_events` row stores the raw JSON payload **and** the **Zod schema
version** that produced it, so consumers validate against the correct schema version (parity with
the versioned adapter I/O schemas in
[`03-agent-adapter-architecture.md`](03-agent-adapter-architecture.md) §11.4).

Sequential execution is enforced by policy (locks/lanes), not schema.

## 7. Lifecycle Model

The canonical state lists (planning, execution, failure/escalation, completion/design-document,
readiness, clarification) are defined once in [`00-glossary-and-terms.md`](00-glossary-and-terms.md)
§3. Subsystems must use those names.

**Where current state lives.** Each machine's _current_ state is a column on its own entity table
(e.g., `feature_requests`/`feature_runs` for execution, `implementation_plans` for the plan,
`clarification_sessions` for clarification, `projects` for the project machine, `agent_runs`,
`triggerdev_runs`, `artifact_exports`). `workflow_states` holds cross-cutting workflow status and
the current-active-feature pointer; `workflow_events` is the append-only transition history. State
columns are never duplicated across tables.

## 8. Data Design

MiniCoder stores authoritative system state in its database (SQLite or PostgreSQL). Core table
groups:

- **Project and repository:** `projects`, `repositories`, `github_links`
- **Planning:** `specification_inputs`, `planning_readiness_assessments`, `planning_gaps`,
  `planning_questions`, `planning_assumptions`, `clarification_sessions`, `clarification_questions`,
  `clarification_answers`, `clarification_decisions`, `implementation_plans`, `plan_sections`,
  `feature_requests` (incl. `kind` ∈ {feature, discovery} and `executable` flag — activation
  excludes `kind = discovery`; see [`02-bootstrap-planner-clarification.md`](02-bootstrap-planner-clarification.md) §5),
  `feature_dependencies`, `acceptance_criteria`, `test_expectations`
  (gaps and assumptions raised during clarification reuse `planning_gaps` / `planning_assumptions`
  with a nullable `clarification_session_id`; there are no separate `clarification_gaps` /
  `clarification_assumptions` tables)
- **Workflow:** `workflow_states`, `feature_runs` (one row per feature execution attempt:
  `feature_request_id`, `attempt_no`, `current_execution_state`, `lock_id`, `started_at`,
  `ended_at`, `outcome`), `workflow_events`, `human_approvals`, `policy_decisions`,
  `merge_gate_evaluations` (one structured evidence record per merge-gate run — see §12)
- **Consistency / durability:** `idempotency_keys` (with a TTL — retained N days, then swept by the
  scheduled drainer), `outbox_events`, `inbox_events`
  (GitHub webhook events; both store the JSON payload **plus** its `payload_schema_version`),
  `workflow_locks` (locks/leases **with a `fence` token** for sequential execution; see §6),
  `triggerdev_runs` (correlation: `triggerdev_run_id`, `triggerdev_task_id`, `triggerdev_status`,
  `last_seen_at`, `linked_workflow_event_id`, `linked_agent_run_id`, `linked_feature_run_id`)
- **Agents:** `agent_adapters`, `agent_capabilities`, `agent_configurations`, `agent_runs`,
  `agent_errors`, `agent_tool_operations`, `agent_context_packs`, `adapter_conformance_results`
- **Review and disagreement:** `review_findings`, `coder_responses`, `disagreement_records`
- **Cost and observability:** `budget_policies` (scope ∈ {project, feature, review_cycle};
  `scope_ref`; `soft_limit`; `hard_limit`; `currency`; `window`; `active`), `cost_records`
- **Artifacts and design documents:** `artifact_exports`, `design_documents`,
  `design_document_sections`, `design_decisions`, `glossary_terms`

**Data design conventions** (a full ERD — primary keys, foreign keys, cardinalities, uniqueness
constraints, and indexes — is authored as an implementation Phase 1 deliverable). Every table:

- has a stable primary key and explicit foreign keys with referential integrity;
- carries an optimistic-concurrency `version` column and `created_at` / `updated_at` timestamps
  (UTC), portable across SQLite and PostgreSQL;
- declares uniqueness and index expectations for its query/lookup paths (e.g., dedup keys,
  idempotency keys, correlation IDs);
- states a retention policy for high-volume rows (events, agent runs, cost records).

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

**API conventions** (defined now; the full OpenAPI-first contract is an implementation Phase 13
deliverable):

- **Command envelope:** commands accept a typed payload and return `{ command_id, accepted,
resulting_state, emitted_event_ids }`; state changes happen only through commands (§4.5).
- **Idempotency:** mutating requests carry an `Idempotency-Key` header mapped to the
  `idempotency_keys` table; replays return the original result.
- **Errors:** RFC 9457 **problem-details** (`type`, `title`, `status`, `detail`, `instance`) with a
  stable machine-readable error code.
- **Pagination:** list endpoints use cursor pagination (`?cursor=&limit=`) with a `next_cursor`.
- **Audit metadata:** every request records actor identity, role, and correlation ID.
- **Authorization matrix:** each command/query declares the minimum role
  (`viewer`/`operator`/`approver`/`admin`, glossary §4.4) enforced by the backend.

**Command contract.** Each command is specified with: purpose, required role, input schema (Zod),
validation rules, transaction boundary, emitted events, outbox records, failure modes, and
idempotency behavior. Core command contracts are **introduced in implementation Phase 2** (alongside
the command layer and the state-transition matrix) and **completed and exposed via OpenAPI in Phase
13**.

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

**Merge authorization model.** `approved_by_policy` is computed automatically by the merge gate. The
actual merge is **initiated by an `approver`/`admin` via `merge-if-ready`**, which re-evaluates the
full gate immediately before invoking GitHub. "Required human approvals exist" (below) refers to
upstream approvals recorded in `human_approvals` (e.g., assumption acceptance, budget override), not
to the `merge-if-ready` invocation itself.

A pull request may be merged only when it belongs to the active feature, targets the correct base
branch, matches the database branch record, CI checks pass, no unresolved blocking findings remain,
no unresolved `requires_human_decision` findings remain, required conversations are resolved,
review-cycle limits are not exceeded, the PR is mergeable, no blocking labels exist, budget gates
pass, required human approvals exist, and GitHub branch protection permits merge.

**Merge-gate evidence.** Every merge-gate run writes a structured `merge_gate_evaluations` record
capturing the inputs and outcome: CI result, review result, unresolved blocking-findings count,
unresolved `requires_human_decision` count, conversation-resolution status, branch-protection
status, budget status, human-approval status, and the final decision (allow / block, with reason).
These records make every merge decision auditable and replayable.

**Gate-input traceability** (each input, the subsystem that produces it, and the phase that delivers
it):

| Merge-gate input                                     | Produced by                                 | Phase |
| ---------------------------------------------------- | ------------------------------------------- | ----- |
| CI result                                            | GitHub Actions → GitHub Integration         | 7     |
| Review findings (blocking / requires_human_decision) | Reviewer adapter + Review/Fix Loop          | 10    |
| Conversation resolution                              | GitHub Integration                          | 7     |
| Branch protection / mergeability                     | GitHub Integration                          | 7     |
| Budget status                                        | Budget-gate primitive (Cost Manager)        | 8     |
| Human approvals                                      | Human-required workflow / `human_approvals` | 11    |

## 13. Final System Design Document

### 13.1 Project Acceptance Validation

"Final validation" before design-document generation is an explicit, automated **Project Acceptance
Validation** suite. The project may advance to `implementation_complete` only when all of the
following pass: the full test suite (unit/integration/system), migration validation, build,
lint/typecheck, the security scan (dependency audit, secret scan, SAST — see
[`00-glossary-and-terms.md`](00-glossary-and-terms.md) §7), documentation-completeness check, a
`state doctor` / reconciliation pass with no outstanding divergence, and a clean artifact-export
pass. Failure holds the project and records the failing gate.

### 13.2 Document Sections

After all approved features are merged and Project Acceptance Validation passes, MiniCoder generates
a final System Design Document with exactly these top-level sections:

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
- **Trigger.dev Cloud — option.** Managed SaaS; no infrastructure to run (task payloads leave the
  user's boundary — a security/compliance decision, not merely deployment config; see
  [`07-security-and-secrets.md`](07-security-and-secrets.md) §6a).

All tiers share the same SDK, task contracts, queues, schedules, waitpoints, and run metadata, so
switching backends is a deployment/configuration decision, not an architecture change.

## 15. Security

Core principles (full specification in [`07-security-and-secrets.md`](07-security-and-secrets.md)):
MiniCoder must scope provider credentials by adapter, avoid exposing all provider tokens to the
orchestrator where not required, redact secrets, avoid storing secrets in the database, avoid
writing secrets to Markdown artifacts, avoid storing private chain-of-thought, verify GitHub
webhook signatures, use least-privilege GitHub tokens, and avoid secret-bearing workflows on
untrusted fork code. The security foundation (config/secrets abstraction, audit actor identity,
local auth, webhook-secret management, redaction tests) is established early — implementation Phases
1–3 — not deferred to the API phase. Workspace sandboxing, egress control, and prompt-injection
defenses for untrusted PR code are specified in `07-security-and-secrets.md` and the Adapter
Execution Contract ([`03-agent-adapter-architecture.md`](03-agent-adapter-architecture.md)).

## 16. Technology Stack and Future Extensions

The locked technology stack is defined in [`00-glossary-and-terms.md`](00-glossary-and-terms.md) §7.

Explicitly deferred future extensions: parallel feature execution, multi-SCM support, multiple
active repositories, advanced enterprise RBAC, PDF/DOCX export, and a plugin marketplace. These are
future features, not alternate initial architectures. (The Trigger.dev execution backend is a
deployment axis, not a deferred extension — see §14.)
