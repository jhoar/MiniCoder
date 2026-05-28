# MiniCoder — Bootstrap Planner and Clarification Specification

## 1. Purpose

The Bootstrap Planner turns user input/specifications into approved database-backed implementation plans and feature requests.

It includes readiness assessment, clarification, automated tests, and artifact export/import.

---

## 2. Authority

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

## 3. Testability

Planner workflows must be testable without human intervention.

Mock planner scenarios:

- sufficient input
- sufficient_with_assumptions
- insufficient input
- blocking gaps
- clarification required
- clarification complete
- invalid planner output
- plan approval simulated
- activation simulated

---

## 4. Lifecycle Tools

Planner test/lifecycle commands:

```bash
minicoder test scenario planning-basic
minicoder test scenario clarification-required
minicoder test scenario backlog-activation
minicoder state doctor
```

---

## 5. Acceptance

- Readiness assessment is automated.
- Clarification can be simulated.
- Backlog activation can be tested without human UI.
