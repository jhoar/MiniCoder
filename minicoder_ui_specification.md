# MiniCoder — UI Specification

## 1. Purpose

MiniCoder provides two user interfaces: Node.js + Ink Text UI and React / Next.js Web UI. Both use the Orchestrator API. Neither UI owns orchestration logic.

## 2. Authority Model

```text
SQLite = authoritative state.
Orchestrator API = UI access path.
Trigger.dev = durable workflow execution.
GitHub = repository and PR truth.
Markdown artifacts = generated/importable snapshots.
```

The UI must not read SQLite directly or parse `backlog.md` as runtime state.

## 3. Shared UI Requirements

Both UIs show project status, planning readiness, clarification sessions, implementation plan, feature queue, active feature, GitHub PR state, Trigger.dev task/waitpoint state, agent runs, review findings, disagreements, cost and budget state, human-required items, artifact exports, final design document status, and adapter configuration/status.

## 4. Text UI

The Text UI supports fast developer/operator workflows.

Commands:

```text
minicoder status
minicoder plan
minicoder clarification
minicoder features
minicoder active
minicoder runs
minicoder findings
minicoder disagreements
minicoder costs
minicoder artifacts
minicoder adapters
minicoder design-doc
```

## 5. Web UI

Pages:

```text
/dashboard
/planning
/clarification
/features
/features/[id]
/pull-requests/[number]
/agent-runs
/findings
/disagreements
/costs
/budgets
/artifacts
/adapters
/design-document
/human-required
/settings
```

## 6. Trigger.dev Visibility

The UI displays Trigger.dev execution through the API: task/run status, queued/running/waiting/succeeded/failed states, retry count, next retry, waitpoint reason, link to Trigger.dev run if available, and mapping to MiniCoder workflow events.

The UI does not call Trigger.dev directly for orchestration decisions.

## 7. Clarification UI

The UI must support displaying readiness score, blocking/non-blocking gaps, clarification questions, answers, accepted/rejected assumptions, continue clarification, complete clarification, and generate plan after readiness is sufficient.

## 8. Design Document UI

The UI must support generating the final design document, viewing document sections, requesting revision, approving the final design document, exporting final-design-document.md, and showing project completion status.

## 9. Command Safety

The UI calls command endpoints only. It does not mutate state directly.

## 10. Roles

Roles are viewer, operator, approver, and admin. Approver/admin permissions are required for plan activation, budget override, disagreement resolution, merge if ready, and final design document approval.

## 11. Acceptance Criteria

The UI is complete when it reads from API only, displays planning, clarification, execution, cost, Trigger.dev, and design document state, supports allowed commands, enforces backend authorization, and does not duplicate orchestration logic.
