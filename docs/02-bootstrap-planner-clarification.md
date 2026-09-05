# MiniCoder — Bootstrap Planner and Clarification Specification

> Status: Canonical
> Supersedes: minicoder_bootstrap_planner_clarification_specification.md,
> minicoder_bootstrap_planner_clarification_specification_testing_updated.md
> Version: 1.0.2
> Last-updated: 2026-09-05

Terms and state names are defined in [`00-glossary-and-terms.md`](00-glossary-and-terms.md).

## 1. Purpose

The MiniCoder Bootstrap Planner converts user input or system specifications into a validated,
approved, database-backed implementation plan and feature backlog. It includes Planning Readiness
Assessment, the Clarification Workflow, assumption management, feature request generation,
dependency ordering, approval and activation, automated testability, and plan.md/backlog.md
export/import.

## 2. Authority Model

```text
MiniCoder database (SQLite local / PostgreSQL hosted) = authoritative planning and backlog state.
Workflow Layer       = durable execution of planning and clarification workflows (implemented by
                       an in-repo, DB-backed task queue — `packages/triggerdev/`, formerly
                       Trigger.dev).
plan.md / backlog.md = optional generated/importable artifacts, never runtime state.
Execution Orchestrator = reads approved feature requests from the database.
```

## 3. Planning Readiness Assessment

Before generating an executable backlog, the planner assesses whether there is enough information.
Readiness outcomes: `sufficient`, `sufficient_with_assumptions`, `insufficient` (glossary §3.5).

Assessment records include readiness status, readiness score, blocking gaps, non-blocking gaps,
assumptions, clarification questions, recommended next action, and backlog-generation-allowed flag.
Any blocking gap prevents activation unless resolved or explicitly accepted by an authorized human.

A blocking `planning_gaps` row can be raised either by clarification itself or by a later
plan/backlog generation pass (the planner adapter can surface a new gap it discovers while
drafting content that clarification's own questions never touched) — the resolution mechanism is
the same regardless of origin: `ResolvePlanningGapCommand` (approver+, requires
`expectedVersion`/`resolution` text, writes both a `human_approvals` row and a
`planning_gap.resolved` `workflow_events` row) sets the gap's `resolved_at`/`resolution` columns.
`SubmitPlanForApprovalCommand`'s "no unresolved blocking gaps" guard checks these columns directly,
so submission is rejected (`409 unresolved-blocking-gaps`) until every blocking gap for the plan's
assessment has one. `minicoder plan resolve-gap` (USER-MANUAL.md §5.6) is the CLI wrapper.

## 4. Clarification Workflow

Clarification resolves missing, ambiguous, or risky requirements before backlog generation or
activation. Statuses are defined in glossary §3.6.

Clarification records: `clarification_sessions`, `clarification_questions`, `clarification_answers`,
`clarification_decisions`. Gaps and assumptions are **not** stored in clarification-specific tables;
they use the shared `planning_gaps` and `planning_assumptions` tables with a nullable
`clarification_session_id` linking those raised or resolved during clarification (see
[`01-system-specification.md`](01-system-specification.md) §8).

Clarification questions should be prioritized and limited. Recommended limit: 3–7 questions per
clarification round.

**Clarification circuit breaker.** To prevent runaway cost and indefinitely stalled workflows,
clarification is bounded on two axes (both are policy settings, and reaching either is recorded as a
workflow event):

- **Per-round response timeout** — if a human does not answer an open clarification round within a
  configurable timeout, the session is marked stalled and escalated.
- **Maximum rounds** — if readiness has not reached `sufficient` or `sufficient_with_assumptions`
  after a configurable maximum number of rounds (default: 3), MiniCoder moves the session to
  `clarification_blocked` and raises a `human_required` escalation event rather than looping.

## 5. Planner Workflow

```text
ingest specification
    ↓
planning readiness assessment
    ↓
clarification if required
    ↓
generate implementation plan
    ↓
generate feature requests
    ↓
validate backlog
    ↓
human approval
    ↓
activate backlog
```

If readiness is `insufficient`, generate clarification questions or a **discovery backlog**. A
`discovery_backlog` is a **non-executable** planning output (a list of investigation/spike items to
reduce uncertainty); it is explicitly not an executable backlog and **cannot activate feature
requests**. Do not activate an executable backlog while readiness is `insufficient`.

A discovery backlog is **persisted as `feature_requests` rows with `kind = "discovery"` and
`executable = false`** (reusing existing storage); activation explicitly excludes
`kind = "discovery"` (see §10). It is not a separate table or state machine.

## 6. Workflow Layer Tasks

```text
ingest-specification
planning-readiness-assessment
start-clarification
record-clarification-answer
complete-clarification
generate-implementation-plan
generate-feature-backlog
validate-backlog
request-plan-approval
activate-approved-backlog
export-plan
export-backlog
import-backlog
```

The Workflow Layer manages retries, waitpoints, and long-running planner calls. Tasks are idempotent and
call Orchestrator Core commands. The database remains authoritative.

## 7. Planner Agent Adapter

Planner work is performed through `PlannerAgentAdapter`. Implementations include
`MockPlannerAdapter`, `GenericLLMPlannerAdapter`, and a human planner via `HumanAgentAdapter`. The
planner adapter produces structured output, not final runtime state.

**`GenericLLMPlannerAdapter` (issue #32, `packages/adapters-planner`)** is the delivered reference
implementation, mirroring `packages/adapters-reviewer`'s shape exactly: a sandbox-free adapter
calling a single injected `PlanProvider` seam (`HttpPlanProvider`, a plain-`fetch`
OpenAI-compatible client — no vendor SDK). `PlannerAgentAdapter` has three methods:

- `run(input)` — the original readiness-assessment contract (Phase 6).
- `generatePlanSections(input)` — additive (issue #32): generates `{title, summary?, sections}`
  from a specification, matching `GenerateImplementationPlanHandler`'s existing payload shape so a
  caller can pass the output straight through.
- `generateFeatureBacklog(input)` — additive (issue #32): generates a `GeneratedFeature[]` list
  from plan sections, matching `GenerateFeatureBacklogPayload.features`'s `FeatureInputSchema`
  shape exactly.

Both new methods are additive to the interface; `GenerateImplementationPlanHandler`/
`GenerateFeatureBacklogHandler` themselves are unchanged and still accept caller-supplied
plan/feature content directly (docs/06 Phase 6) — a caller now has the _option_ of first calling
the adapter to generate that content, rather than being required to invent it ad hoc, but nothing
about the handlers' own contracts changed.

`packages/triggerdev/src/triggerdev-tasks.ts`'s `resolveDefaultPlannerAdapter()` constructs a real
`GenericLLMPlannerAdapter` from the same `CODE_GEN_BASE_URL`/`CODE_GEN_API_KEY`/`CODE_GEN_MODEL`
env vars the Coder/Reviewer default resolvers already read (async, dynamic `import()`, same
pattern) — a live `planning-readiness-assessment` deployment no longer fails fast with "no planner
adapter configured."

## 8. Output Records

The planner writes `specification_inputs`, `planning_readiness_assessments`, `planning_gaps`,
`planning_questions`, `planning_assumptions`, `clarification_sessions`, `clarification_questions`,
`clarification_answers`, `clarification_decisions`, `implementation_plans`, `plan_sections`,
`feature_requests`, `feature_dependencies`, `acceptance_criteria`, `test_expectations`,
`human_approvals`, `workflow_events`, `agent_runs`, `cost_records`, and `artifact_exports`.

## 9. Feature Request Quality Rules

A feature request must be small enough for one PR, large enough to be meaningful, independently
reviewable, ordered by dependencies, explicit about acceptance criteria, explicit about test
expectations, clear enough for a Coder Agent to implement, and clear enough for a Reviewer Agent to
review.

## 10. Approval and Activation

Plans must be approved before execution. Approval actions:

```text
approve
reject
request_revision
approve_with_assumptions
activate_for_execution
```

Activation moves the plan to the `activated_for_execution` planning state and writes each generated
feature request into the execution lifecycle at `approved_pending_execution` (glossary §3.1–§3.2).

## 11. Artifact Export / Import

`plan.md` and `backlog.md` are generated from the database. Imports must follow:
parse → validate → preview → approve → transactional database import. No runtime logic reads
`backlog.md` as a source of truth.

**`backlog.md` parser (issue #33):** `parseBacklogMarkdown()` (`@minicoder/core`) implements the
"parse" step for `backlog.md`, converting `ExportBacklogHandler`'s Markdown output back into
`ImportBacklogPayload.features`. It is a pure function — no DB access — matching the principle
above: the parser turns a Markdown _snapshot_ into the same structured shape a caller could have
hand-built, it never becomes a runtime source of truth. `minicoder plan import-backlog <file>`
(`packages/cli/src/commands/plan.ts`) wires it end to end: read file → `parseBacklogMarkdown()` →
dispatch `ImportBacklogCommand` (supports `--dry-run` for the preview step).

The current `backlog.md` format (`ExportBacklogHandler`) is constrained — it emits only `fr_id`,
`title`, `Kind:`, and a free-text description per feature section; it does **not** emit
`priority` or dependency edges. Consequently:

- **`priority` is reconstructed from each feature's position in the document** (0-based, matching
  the `ORDER BY priority ASC, fr_id ASC` the export query already uses), not from the original
  numeric value. A round trip preserves relative ordering, not the original priority numbers.
- **`dependsOnFrIds` is always empty** on import — the format has no section to carry dependency
  information in a re-imported backlog.

Malformed input (a missing `# Feature Backlog` heading, no feature sections, a duplicate `fr_id`,
a missing/invalid `Kind:` line, or an empty description) throws `BacklogParseError` with a 1-based
line number, so `minicoder plan import-backlog` fails fast with an actionable message rather than
importing a partial or incorrect backlog.

## 12. Testability

Planner workflows must be testable without human intervention. Mock planner scenarios:

- sufficient input
- sufficient_with_assumptions
- insufficient input
- blocking gaps
- clarification required
- clarification complete
- invalid planner output
- plan approval simulated
- activation simulated

Relevant lifecycle/test commands (full surface in glossary §5):

```bash
minicoder test scenario planning-basic
minicoder test scenario clarification-required
minicoder test scenario backlog-activation
minicoder state doctor
```

## 13. Acceptance Criteria

The Bootstrap Planner is complete when it can ingest user input, assess readiness, run
clarification, generate structured plans and features, validate feature quality, require approval,
activate approved features as `approved_pending_execution`, export/import Markdown artifacts safely,
and run readiness/clarification/activation in automated tests without a human UI.
