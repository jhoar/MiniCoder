# MiniCoder — UI Specification

> Status: Canonical
> Supersedes: minicoder_ui_specification.md, minicoder_ui_specification_testing_updated.md
> Version: 1.0.1
> Last-updated: 2026-07-06

## 1. Purpose

MiniCoder provides two user interfaces: a Node.js + Ink Text UI and a React / Next.js Web UI. Both
use the Orchestrator API. Neither UI owns orchestration logic, reads the database directly, or
parses `backlog.md` as runtime state.

## 2. Authority Model

```text
MiniCoder database = authoritative state.
Orchestrator API   = UI access path.
Workflow Layer     = durable workflow execution (implemented by Trigger.dev).
GitHub             = repository and PR truth.
GitHub webhooks    = primary external GitHub event source (surfaced via API read models).
Markdown artifacts = generated/importable snapshots.
```

## 3. Shared UI Requirements

Both UIs show project status, planning readiness, clarification sessions, implementation plan,
feature queue, active feature, GitHub PR state, Workflow Layer task/waitpoint state, agent runs, review
findings, disagreements, cost and budget state, human-required items, artifact exports, final design
document status, adapter configuration/status, and **system state health** (see §8).

## 4. Text UI

Supports fast developer/operator workflows.

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
minicoder pause          # operator pause → paused_by_operator (glossary §3.8)
minicoder resume         # resume → running (records a resumed event)
```

(State-lifecycle and test commands — `db`, `trigger`, `state`, `github`, `test` — are defined in
[`00-glossary-and-terms.md`](00-glossary-and-terms.md) §5 and surfaced operationally, not as UI
navigation.)

**Implementation notes (Phase 14).** Each command renders once (fetch, render, exit) rather than a
persistent full-screen app, matching "fast developer/operator workflows"; every command also
accepts `--json` to print the raw API response for scripting. "Human-required items" and
"state-health" (§3/§8) are not separate command tokens — they are `minicoder features
--human-required` (backed by a dedicated `GET /human-required-items`, since
`feature_requests.state` is a static label that never reaches `human_required` — only
`feature_runs.current_execution_state` does) and a section inside `minicoder status` (backed by
`GET /triggerdev-runs` for Workflow Layer visibility and, when the configured API key is
operator-or-above, `POST /commands/doctor`; a `viewer`-role key simply omits that section — the API
enforces the role check, not the TUI). `minicoder status`/`pause`/`resume` also rely on a `version`
field added to `GET /status`'s `workflowState` (needed for `pause`/`resume`'s `expectedVersion`) and
on a new `GET /whoami` (echoes the configured key's role/actorKind/id, since there is otherwise no
way for the TUI to discover its own permissions ahead of a call).

## 5. Web UI Pages

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
/state-health
/settings
```

## 6. Workflow Layer Visibility

The UI displays Workflow Layer execution through the API: task/run status, queued/running/waiting/
succeeded/failed states, retry count, next retry, waitpoint reason, link to the underlying
Trigger.dev run if available, and mapping to MiniCoder workflow events. The UI does not call
Trigger.dev directly for
orchestration decisions.

## 7. Clarification UI

Supports displaying readiness score, blocking/non-blocking gaps, clarification questions, answers,
accepted/rejected assumptions, continue clarification, complete clarification, and generate plan
after readiness is sufficient.

## 8. State Health and Admin UI

The UI exposes system health derived from API read models: database state status, Workflow Layer
run/waitpoint status, GitHub webhook/reconciliation status, state-doctor results, failed
outbox/inbox events, test/scenario results, diagnostics exports, and environment mode.

Admin actions (backend-authorized, audited): run state validation, trigger reconciliation, export
diagnostics, view system-test history, view stuck Trigger.dev runs, and view stale workflow locks.
Destructive actions must be guarded and backend-authorized; the UI never performs direct state
mutation.

## 9. Design Document UI

Supports generating the final design document, viewing document sections, requesting revision,
approving the final design document, exporting `final-design-document.md`, and showing project
completion status.

## 10. Command Safety and Roles

The UI calls command endpoints only and does not mutate state directly. Roles are `viewer`,
`operator`, `approver`, and `admin` (canonical in
[`00-glossary-and-terms.md`](00-glossary-and-terms.md) §4.4). Approver/admin permissions are required for plan activation,
budget override, disagreement resolution, merge-if-ready, final design document approval, and
state-lifecycle/destructive admin actions.

## 11. Acceptance Criteria

The UI is complete when it reads from the API only; displays planning, clarification, execution,
cost, Workflow Layer, state-health, and design-document state; supports allowed commands; surfaces
test/scenario and reconciliation status; enforces backend authorization; performs no direct state
mutation; and does not duplicate orchestration logic.
