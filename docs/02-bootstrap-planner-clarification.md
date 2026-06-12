# MiniCoder — Bootstrap Planner and Clarification Specification

> Status: Canonical
> Supersedes: minicoder_bootstrap_planner_clarification_specification.md,
> minicoder_bootstrap_planner_clarification_specification_testing_updated.md
> Version: 1.0.0
> Last-updated: 2026-06-12

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
Workflow Layer       = durable execution of planning and clarification workflows
                       (implemented by Trigger.dev).
plan.md / backlog.md = optional generated/importable artifacts, never runtime state.
Execution Orchestrator = reads approved feature requests from the database.
```

## 3. Planning Readiness Assessment

Before generating an executable backlog, the planner assesses whether there is enough information.
Readiness outcomes: `sufficient`, `sufficient_with_assumptions`, `insufficient` (glossary §3.5).

Assessment records include readiness status, readiness score, blocking gaps, non-blocking gaps,
assumptions, clarification questions, recommended next action, and backlog-generation-allowed flag.
Any blocking gap prevents activation unless resolved or explicitly accepted by an authorized human.

## 4. Clarification Workflow

Clarification resolves missing, ambiguous, or risky requirements before backlog generation or
activation. Statuses are defined in glossary §3.6.

Clarification records: `clarification_sessions`, `clarification_questions`, `clarification_answers`,
`clarification_gaps`, `clarification_assumptions`, `clarification_decisions`.

Clarification questions should be prioritized and limited. Recommended limit: 3–7 questions per
clarification round.

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

If readiness is `insufficient`, generate clarification questions or a discovery backlog. Do not
activate an executable backlog.

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
