# MiniCoder — Unified System Specification

## 1. Purpose

MiniCoder is an agentic software development orchestration system. It converts user intent or system specifications into a clarified, approved, sequential implementation backlog, then coordinates implementation through feature branches, pull requests, reviews, fixes, merge gates, and final documentation.

MiniCoder is designed to support agent-assisted software development while remaining auditable, deterministic, cost-aware, and safe.

## 2. Scope

MiniCoder includes Bootstrap planning, planning readiness assessment, clarification workflow, structured implementation plan generation, SQLite-backed feature backlog, sequential feature execution, vendor-neutral agent adapters, GitHub branch and pull request workflow, structured review/fix loops, disagreement and human escalation, Trigger.dev durable workflow execution, cost management, observability and audit records, Orchestrator API, Node.js + Ink Text UI, React / Next.js Web UI, Markdown artifact import/export, and final System Design Document generation.

MiniCoder does not initially include parallel feature execution, SCM providers other than GitHub, multi-repository orchestration, PostgreSQL migration, self-hosted Trigger.dev, PDF/DOCX exports, or advanced enterprise RBAC. These are future extensions, not separate architectures.

## 3. One Target Architecture

MiniCoder has one target architecture. There is no separate “first system” and “production system.” The implementation may be phased, but the architecture is fixed.

```text
SQLite = authoritative planning, backlog, workflow, review, event, agent-run, cost, and design-document state.
Trigger.dev = durable workflow execution engine.
GitHub = authoritative repository, branch, commit, pull request, review, CI/check, and merge state.
GitHub Actions = CI, tests, build validation, and deployment of Trigger.dev tasks.
Orchestrator Core = state machine, command handlers, policy checks, merge gates, and database writes.
Orchestrator API = safe command and query interface.
UI = thin clients over the API.
Agents = invoked through vendor-neutral role-based adapters.
plan.md / backlog.md / final-design-document.md = generated/importable artifacts, not runtime state.
```

Deployment modes may vary, but the architecture does not.

## 4. System Name

The system is named **MiniCoder**.

Formal title:

```text
MiniCoder — Agentic Software Development Orchestration System
```

Subsystem names:

- MiniCoder Bootstrap Planner
- MiniCoder Clarification Workflow
- MiniCoder Execution Orchestrator
- MiniCoder Agent Adapter Architecture
- MiniCoder Trigger.dev Workflow Layer
- MiniCoder GitHub Integration
- MiniCoder Orchestrator API
- MiniCoder Text UI
- MiniCoder Web UI
- MiniCoder Design Document Generator

## 5. Core Design Principles

### 5.1 SQLite-First State

SQLite is authoritative for MiniCoder state from the beginning. No runtime orchestration logic shall depend on parsing `backlog.md`.

### 5.2 Trigger.dev From the Start

MiniCoder shall use Trigger.dev as its durable workflow execution engine from the early implementation phases.

Trigger.dev owns durable task execution, retries, queues, schedules, waitpoints, and resumable long-running workflows.

Trigger.dev does not own domain state, state-machine rules, merge policy, agent contracts, business logic, or GitHub truth. Trigger.dev tasks must call Orchestrator Core commands.

### 5.3 GitHub as Repository Truth

GitHub is authoritative for branches, commits, pull requests, reviews, comments, CI/check status, conversation resolution, mergeability, and merge result. SQLite is authoritative for orchestration intent, history, and policy decisions. MiniCoder reconciles SQLite state against GitHub state.

### 5.4 Vendor-Neutral Agents

MiniCoder integrates agents through role-based adapters. The core system must not depend on Codex, Claude, Copilot, Cursor, Aider, OpenHands, or any other specific product. Reference adapters may include Codex and Claude, but they are not architectural dependencies.

### 5.5 Command-Based Orchestration

All state-changing operations go through commands. Prefer `POST /actions/merge-if-ready`; avoid arbitrary status mutation such as `PATCH /features/FR-002 { "status": "merged" }`.

### 5.6 No Chain-of-Thought Storage

MiniCoder must not request, capture, store, or expose private model chain-of-thought. It may store structured outputs, decision summaries, evidence references, tool calls, token counts, cost records, policy decisions, and error summaries.

### 5.7 Sequential Execution

MiniCoder executes one feature request at a time. At most one feature request may be active unless a future parallel-execution feature explicitly enables more.

### 5.8 Human Approval for Irreversible or Risky Steps

Human approval is required for activating generated backlogs, accepting unresolved planning assumptions, budget overrides, review-loop limit overrides, ambiguous feature resolution, human-required recovery, and final design document approval.

## 6. Major Subsystems

### 6.1 Bootstrap Planner

The Bootstrap Planner converts user input or specifications into a structured implementation plan and feature requests. It writes structured records to SQLite. It does not produce the executable backlog by writing `backlog.md`.

### 6.2 Planning Readiness Assessment

Before generating an executable backlog, the planner performs a readiness assessment. Statuses are `sufficient`, `sufficient_with_assumptions`, and `insufficient`. The assessment identifies blocking gaps, non-blocking gaps, assumptions, clarification questions, readiness score, and backlog-generation eligibility. Blocking gaps prevent backlog activation unless resolved or explicitly accepted by an authorized human.

### 6.3 Clarification Workflow

Clarification is the structured dialogue workflow used to resolve missing, ambiguous, or risky requirements before backlog generation or activation. Clarification replaces terms such as “deep interview.”

Clarification includes sessions, questions, answers, gaps, assumptions, decisions, and score. Statuses are `clarification_not_required`, `clarification_required`, `clarification_in_progress`, `clarification_complete`, and `clarification_blocked`.

If blocking gaps remain after clarification, MiniCoder must not activate an executable backlog unless an authorized human explicitly accepts the risk.

### 6.4 Execution Orchestrator

The Execution Orchestrator selects approved feature requests from SQLite and moves them through the controlled execution lifecycle. It owns feature selection, state transition validation, GitHub reconciliation, agent invocation coordination, review/fix loop control, merge gate evaluation, human escalation, and final implementation-complete detection.

### 6.5 Trigger.dev Workflow Layer

Trigger.dev executes durable workflows and tasks. Task families include planning readiness assessment, clarification, plan generation, backlog activation, start next feature, coder run, reviewer run, review/fix loop, disagreement resolution, merge gate, GitHub reconciliation, artifact export, cost recalculation, and final design document generation. Trigger.dev task IDs and run metadata are linked to SQLite workflow events and agent runs.

### 6.6 Agent Adapter Architecture

MiniCoder defines role-based adapters: PlannerAgentAdapter, CoderAgentAdapter, ReviewerAgentAdapter, ArbiterAgentAdapter, DocumentationAgentAdapter, and HumanAgentAdapter. Adapters declare capabilities, normalize outputs, normalize errors, and record agent runs.

### 6.7 GitHub Integration

The GitHub integration owns all GitHub API operations: repository inspection, branch lookup/creation, PR lookup/creation, PR state reading, review reading, check/status reading, mergeability reading, status check publication, and merge operation when policy permits.

### 6.8 Review/Fix Loop Controller

The review/fix loop controller manages structured review cycles between Coder and Reviewer agents. Loops are bounded. Default limits are five review cycles per feature, two fix attempts per finding, and one reopening of the same finding.

### 6.9 Disagreement Manager

The Disagreement Manager detects unresolved or circular coder/reviewer conflicts and routes them to the Arbiter or Human Agent.

### 6.10 Merge Gate

The Merge Gate evaluates whether a PR may be merged. It publishes `agent-orchestrator/review-gate`. Merge is allowed only when all policy and GitHub conditions pass.

### 6.11 Cost Manager

The Cost Manager tracks and enforces budgets by project, feature, agent run, role, adapter, provider, model, and review cycle. Budget overruns can pause automation or require human approval.

### 6.12 Observability and Event System

MiniCoder records workflow events, agent runs, tool operations, GitHub operations, review findings, coder responses, disagreements, policy decisions, cost records, human approvals, and Trigger.dev run references.

### 6.13 Orchestrator API

The API exposes read models and commands. It is the only supported access path for TUI and Web UI.

### 6.14 Text UI

The Text UI is implemented with Node.js + Ink and supports developer/operator workflows.

### 6.15 Web UI

The Web UI is implemented with React / Next.js and supports team visibility, approvals, cost dashboards, artifact management, and human-required workflows.

### 6.16 Artifact Generator

The Artifact Generator exports `plan.md`, `backlog.md`, `final-design-document.md`, and optional future PDF/DOCX exports. Artifacts are generated from SQLite and source repository state.

### 6.17 Design Document Generator

The Design Document Generator produces the final System Design Document after implementation completion. It is triggered by the Execution Orchestrator once all approved features are merged and final validation passes. It may use a DocumentationAgentAdapter to draft the document. A human must approve the final document before the project is marked complete.

## 7. Lifecycle Model

Planning lifecycle:

```text
draft → pending_approval → approved → activated_for_execution → approved_pending_execution
```

Execution lifecycle:

```text
approved_pending_execution → selected → coding → code_pushed → pr_opened → ci_running → under_review → changes_requested → fixing → code_pushed → under_review → approved_by_policy → merge_ready → merged
```

Failure and escalation states:

```text
blocked
failed
human_required
```

Completion and design document states:

```text
implementation_complete
design_document_generating
design_document_ready_for_review
design_document_revision_requested
design_document_approved
project_complete
```

## 8. Data Design

MiniCoder stores authoritative system state in SQLite.

Core table groups:

- Project and repository: `projects`, `repositories`, `github_links`
- Planning: `specification_inputs`, `planning_readiness_assessments`, `planning_gaps`, `planning_questions`, `planning_assumptions`, `clarification_sessions`, `clarification_questions`, `clarification_answers`, `clarification_decisions`, `implementation_plans`, `plan_sections`, `feature_requests`, `feature_dependencies`, `acceptance_criteria`, `test_expectations`
- Workflow: `workflow_states`, `workflow_events`, `human_approvals`, `policy_decisions`
- Agents: `agent_adapters`, `agent_capabilities`, `agent_configurations`, `agent_runs`, `agent_errors`, `agent_tool_operations`, `agent_context_packs`, `adapter_conformance_results`
- Review and disagreement: `review_findings`, `coder_responses`, `disagreement_records`
- Cost and observability: `cost_records`
- Artifacts and design documents: `artifact_exports`, `design_documents`, `design_document_sections`, `design_decisions`, `glossary_terms`

## 9. API Design

The Orchestrator API exposes read endpoints and commands.

Read endpoint groups include projects, repositories, specification inputs, planning readiness, clarification sessions, implementation plans, features, active feature, GitHub links, pull requests, review findings, disagreements, agent runs, workflow events, policy decisions, costs, budgets, artifacts, design documents, agent adapters, agent configuration, and status.

Command endpoint groups include ingest specification, assess planning readiness, start clarification, answer clarification question, complete clarification, generate plan, approve plan, activate backlog, start next feature, request coder run, request review, request fixes, reconcile state, recompute merge gate, merge if ready, resolve disagreement, approve budget override, pause, resume, export plan, export backlog, generate final design document, and approve final design document.

## 10. Agent Adapter Contracts

PlannerAgentAdapter produces readiness assessments, clarification prompts, implementation plans, and feature requests.

CoderAgentAdapter implements approved feature requests on assigned branches.

ReviewerAgentAdapter reviews PRs and returns structured findings.

ArbiterAgentAdapter resolves structured disagreements.

DocumentationAgentAdapter drafts the final System Design Document from structured MiniCoder records and repository evidence.

HumanAgentAdapter represents manual approval, fallback, and human-required decisions.

## 11. Review Finding Model

Each review finding includes finding ID, feature request ID, pull request number, severity, category, file, line, evidence, required action, acceptance criteria reference, policy reference, and status.

Allowed severities are `blocking`, `non_blocking`, `question`, `nit`, `out_of_scope`, and `requires_human_decision`. Only blocking findings prevent merge.

## 12. Merge Policy

A pull request may be merged only when it belongs to the active feature, targets the correct base branch, matches the SQLite branch record, CI checks pass, no unresolved blocking findings remain, required conversations are resolved, review cycle limits are not exceeded, the PR is mergeable, no blocking labels exist, budget gates pass, required human approvals exist, and GitHub branch protection permits merge.

## 13. Final System Design Document

After all approved features are merged and final validation passes, MiniCoder generates a final System Design Document.

The document shall include exactly these top-level sections:

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

MiniCoder supports one architecture with deployment options.

Initial deployment mode: local developer machine, SQLite file, Trigger.dev development or cloud, GitHub repository, local API, local TUI, optional local Web UI.

Hosted/team deployment mode: hosted API, persistent SQLite volume or future managed database, Trigger.dev cloud or self-hosted Trigger.dev, GitHub OAuth, Web UI.

Cloud vs self-hosted Trigger.dev is a deployment choice, not an architecture change.

## 15. Security

MiniCoder must scope provider credentials by adapter, avoid exposing all provider tokens to the orchestrator where not required, redact secrets, avoid storing secrets in SQLite, avoid writing secrets to Markdown artifacts, avoid storing private chain-of-thought, use least-privilege GitHub tokens, and avoid secret-bearing workflows on untrusted fork code.

## 16. Technology Stack

Locked implementation stack:

```text
Language: TypeScript
Runtime: Node.js
Package manager: pnpm
Database: SQLite
Validation: Zod
Testing: Vitest
GitHub API: Octokit
Workflow execution: Trigger.dev
API framework: Fastify
Text UI: Ink
Web UI: React / Next.js
```

## 17. Future Extensions

Explicitly deferred: parallel feature execution, multi-SCM support, PostgreSQL migration, multiple active repositories, advanced enterprise RBAC, self-hosted Trigger.dev, PDF/DOCX export, and plugin marketplace. These are future features, not alternate initial architectures.
