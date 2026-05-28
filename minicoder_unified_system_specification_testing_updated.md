# MiniCoder — Unified System Specification

## 1. Purpose

MiniCoder is an agentic software development orchestration system.

It converts user intent or system specifications into a clarified, approved implementation backlog, then coordinates feature-branch development, pull requests, structured reviews, fixes, merge gates, and final design documentation.

MiniCoder is designed to be auditable, deterministic, cost-aware, safe, and fully testable without human intervention.

---

## 2. Locked Architectural Baseline

```text
MiniCoder = Agentic Software Development Orchestration System.

Local/single-node state store = SQLite on local disk.

Hosted/team state store = PostgreSQL.

Never = SQLite on a network filesystem, shared persistent volume, or network-mounted database file.

Trigger.dev = durable workflow execution engine for tasks, retries, queues, schedules, waitpoints, and resumability.

MiniCoder database = authoritative planning, backlog, workflow, review, event, agent-run, cost, testing, artifact, and design-document state.

GitHub = authoritative repository, branch, commit, pull request, review, CI/check, conversation, mergeability, and merge state.

GitHub webhooks = primary source for external GitHub changes.

Scheduled reconciliation = fallback/repair mechanism.

GitHub Actions = CI, tests, build validation, and deployment of Trigger.dev tasks.

Orchestrator Core = state machine, command handlers, policy checks, merge gates, database writes, idempotency, and reconciliation.

Orchestrator API = safe command and query interface.

UI = API clients only.

Agents = invoked through vendor-neutral role-based adapters.

plan.md / backlog.md / final-design-document.md = generated/importable artifacts, not runtime state.

Sequential execution = policy setting, not schema limitation.

Private chain-of-thought = not stored.

Testing = fully automated by default across unit, integration, system, Docker Compose, and Kubernetes deployments.

State lifecycle tooling = required for database, Trigger.dev, GitHub simulation, agent runs, artifacts, and diagnostics.
```

---

## 3. One Architecture, Multiple Deployment Profiles

MiniCoder has one architecture with deployment profiles.

There is no separate prototype architecture and production architecture.

### 3.1 Local / Single-Node Profile

- SQLite on local disk.
- Trigger.dev development or cloud.
- GitHub repository.
- Local API.
- Local TUI.
- Optional local Web UI.

### 3.2 Hosted / Team Profile

- PostgreSQL.
- Trigger.dev Cloud or self-hosted Trigger.dev.
- Hosted API.
- Web UI.
- GitHub OAuth or equivalent.
- GitHub webhooks.

### 3.3 Explicit SQLite Limitation

SQLite shall not be used over network filesystems, shared persistent volumes, or network-mounted database files.

PostgreSQL is required for hosted/team deployments.

---

## 4. Required Testability

MiniCoder shall be fully testable in unattended mode.

This includes:

- Unit tests.
- Integration tests.
- System tests.
- Docker tests.
- Docker Compose tests.
- Kubernetes tests.
- CI/staging tests.

No MiniCoder workflow should require a human to test it.

Humans approve real work, but automated tests must simulate human actions.

MiniCoder shall include lifecycle tools for:

- database state
- Trigger.dev task state
- GitHub simulated state
- agent-run state
- artifact state
- diagnostics
- recovery

---

## 5. Authority Boundaries

### 5.1 MiniCoder Database

The MiniCoder database is authoritative for planning, backlog, workflow, testing, review, event, agent-run, cost, artifact, and design-document state.

### 5.2 GitHub

GitHub is authoritative for branches, commits, PRs, reviews, comments, checks, and merges.

### 5.3 Trigger.dev

Trigger.dev is authoritative only for Trigger.dev task execution metadata.

Trigger.dev state is correlated into MiniCoder using run IDs and workflow events.

---

## 6. Persistence and Consistency

MiniCoder shall use a persistence abstraction supporting:

- SQLite local/single-node.
- PostgreSQL hosted/team.

Required consistency patterns:

- idempotency keys
- optimistic concurrency/version columns
- outbox events
- inbox/webhook events
- workflow locks/leases
- execution lanes
- scheduled reconciliation
- state doctor tooling

Sequential execution is enforced by policy, not schema.

---

## 7. Trigger.dev

Trigger.dev is used from the start as the durable workflow execution engine.

Trigger.dev tasks are thin wrappers around Orchestrator Core commands.

Trigger.dev tasks must be idempotent.

---

## 8. GitHub Events

GitHub webhooks are the primary event source.

Scheduled reconciliation is a fallback and repair mechanism.

Before expensive agent calls, MiniCoder performs pre-flight GitHub and database checks.

---

## 9. Planning, Readiness, and Clarification

MiniCoder performs readiness assessment before executable backlog generation.

Readiness statuses:

```text
sufficient
sufficient_with_assumptions
insufficient
```

Clarification resolves ambiguity through structured questions and decisions.

---

## 10. Agent Adapter Architecture

Agents are vendor-neutral adapters:

- PlannerAgentAdapter
- CoderAgentAdapter
- ReviewerAgentAdapter
- ArbiterAgentAdapter
- DocumentationAgentAdapter
- HumanAgentAdapter

---

## 11. Observability Without Chain-of-Thought

Private chain-of-thought is not stored.

MiniCoder stores structured observability:

- context pack references
- prompt template versions
- visible outputs where policy allows
- tool calls
- diffs or references
- test excerpts
- structured findings
- decision summaries
- evidence references
- cost/token records
- error summaries

---

## 12. Final Design Document

After all approved features are merged and final validation passes, MiniCoder generates a final System Design Document with 13 required sections and human approval.

---

## 13. Technology Stack

```text
Language: TypeScript
Runtime: Node.js
Package manager: pnpm
Local/single-node DB: SQLite
Hosted/team DB: PostgreSQL
Validation: Zod
Testing: Vitest
GitHub API: Octokit
Workflow execution: Trigger.dev
API framework: Fastify
Text UI: Ink
Web UI: React / Next.js
```

---

## 14. Document Metadata

Generated: 2026-05-22
