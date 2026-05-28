# MiniCoder — Updated Combined Implementation Plan

## 1. Purpose

This plan implements MiniCoder as one architecture with local/single-node and hosted/team deployment profiles.

It includes automated testing and state lifecycle management as foundational requirements.

---

## 2. Phase Overview

| Phase | Name | Outcome |
|---|---|---|
| 1 | Repository and Persistence Foundation | Monorepo, database abstraction, SQLite/PostgreSQL design |
| 2 | State Machine, Idempotency, and Command Layer | Transactional commands, events, idempotency, outbox/inbox |
| 3 | Trigger.dev Workflow Harness | Durable tasks, retries, queues, waitpoints |
| 4 | Test Harness and State Lifecycle Tooling | Automated test modes and lifecycle commands |
| 5 | Agent Adapter Foundation | Vendor-neutral adapters and mocks |
| 6 | Bootstrap Planner, Readiness, and Clarification | Approved database backlog |
| 7 | GitHub Webhooks, Integration, and Reconciliation | Event-driven GitHub sync |
| 8 | Execution Orchestrator | Sequential policy-driven feature execution |
| 9 | Reference Coder Adapter | First replaceable coder |
| 10 | Reference Reviewer Adapter and Review/Fix Loop | Structured review loop |
| 11 | Disagreement, Arbiter, and Human Escalation | Stalemate recovery |
| 12 | Merge Gate and Branch Protection | Safe merge automation |
| 13 | Orchestrator API | Command/query API |
| 14 | Ink Text UI | Operator TUI |
| 15 | Next.js Web UI | Team UI |
| 16 | Observability, Cost, and Recovery | Operational hardening |
| 17 | Final Design Document Generator | Final engineering record |
| 18 | Future Extensions | Parallel execution, multi-repo, more adapters |

---

# Phase 1 — Repository and Persistence Foundation

Deliver:

- TypeScript/pnpm monorepo.
- Database abstraction.
- SQLite local support.
- PostgreSQL hosted/team support.
- Migration tooling.
- Initial schema.

Acceptance:

- SQLite works locally.
- PostgreSQL path is supported.
- No SQLite network-storage assumption exists.

---

# Phase 2 — State Machine, Idempotency, and Command Layer

Deliver:

- Lifecycle states.
- Command framework.
- Transactions.
- Workflow events.
- Idempotency keys.
- Inbox/outbox.
- Workflow locks.
- Execution lanes.

Acceptance:

- Commands are idempotent.
- Sequential execution is policy, not schema.
- Invalid transitions fail.

---

# Phase 3 — Trigger.dev Workflow Harness

Deliver:

- Trigger.dev setup.
- Task wrappers.
- Queue/retry config.
- Waitpoint patterns.
- Trigger.dev run mapping.

Acceptance:

- Tasks call core commands.
- Retries are safe.
- Waitpoints are testable.

---

# Phase 4 — Test Harness and State Lifecycle Tooling

Deliver:

- Unit/integration/system test harness.
- Mock adapters.
- Mock GitHub provider.
- Trigger.dev test harness wrapper.
- Database lifecycle CLI.
- Trigger.dev lifecycle CLI.
- State doctor.
- GitHub event simulation.
- Scenario runner.
- Docker Compose test flow.
- Kubernetes Job test templates.

Required CLI families:

```bash
minicoder db migrate
minicoder db reset
minicoder db seed
minicoder db snapshot
minicoder db restore
minicoder db validate

minicoder trigger deploy
minicoder trigger list-runs
minicoder trigger cancel-run
minicoder trigger replay-run
minicoder trigger drain-queue
minicoder trigger validate
minicoder trigger reconcile

minicoder state inspect
minicoder state validate
minicoder state reconcile
minicoder state doctor
minicoder state export-diagnostics

minicoder test unit
minicoder test integration
minicoder test system
minicoder test scenario planning-basic
minicoder test scenario clarification-required
minicoder test scenario review-loop
minicoder test scenario merge-gate
minicoder test scenario final-design-document
```

Acceptance:

- System tests run without real LLM calls.
- Docker Compose scenario runs unattended.
- Destructive commands are guarded.
- CI can run a system smoke scenario.

---

# Phase 5 — Agent Adapter Foundation

Deliver:

- Adapter interfaces.
- Mock adapters.
- Human test adapter.
- Adapter conformance tests.

---

# Phase 6 — Bootstrap Planner, Readiness, and Clarification

Deliver:

- Specification ingestion.
- Readiness assessment.
- Clarification workflow.
- Plan/backlog generation.
- Approval and activation.
- Markdown export/import.

---

# Phase 7 — GitHub Webhooks, Integration, and Reconciliation

Deliver:

- GitHub webhook receiver.
- Inbox processing.
- GitHub API client.
- Scheduled reconciliation.
- Pre-flight checks.

---

# Phase 8 — Execution Orchestrator

Deliver:

- Feature selection.
- Active feature run records.
- Sequential policy enforcement.
- Trigger.dev flow integration.

---

# Phase 9 — Reference Coder Adapter

Deliver:

- Reference coder adapter.
- Context packs.
- Branch/commit tracking.

---

# Phase 10 — Reference Reviewer Adapter and Review/Fix Loop

Deliver:

- Reference reviewer adapter.
- Structured findings.
- Review/fix loop.

---

# Phase 11 — Disagreement, Arbiter, and Human Escalation

Deliver:

- Disagreement records.
- Arbiter integration.
- Human-required recovery.

---

# Phase 12 — Merge Gate and Branch Protection

Deliver:

- Merge policy engine.
- Review gate status.
- Merge-if-ready command.

---

# Phase 13 — Orchestrator API

Deliver:

- Fastify API.
- Read endpoints.
- Command endpoints.
- Webhook endpoints.

---

# Phase 14 — Ink Text UI

Deliver operator TUI.

---

# Phase 15 — Next.js Web UI

Deliver team UI.

---

# Phase 16 — Observability, Cost, and Recovery

Deliver:

- Cost dashboards.
- Recovery commands.
- Diagnostics.
- Structured observability without CoT.

---

# Phase 17 — Final Design Document Generator

Deliver final design document workflow and approval.

---

# Phase 18 — Future Extensions

Deferred: parallel execution, multi-repo, more SCM providers, self-hosted Trigger.dev, PDF/DOCX export.

---

Generated: 2026-05-22
