# MiniCoder — Bootstrap Planner and Clarification Specification

## 1. Purpose

The MiniCoder Bootstrap Planner converts user input or system specifications into a validated, approved, SQLite-backed implementation plan and feature backlog.

It includes Planning Readiness Assessment, Clarification Workflow, assumption management, feature request generation, dependency ordering, approval and activation, and plan.md/backlog.md export/import.

## 2. Authority Model

```text
SQLite = authoritative planning and backlog state.
Trigger.dev = durable execution of planning and clarification workflows.
plan.md / backlog.md = optional generated/importable artifacts.
Execution Orchestrator = reads approved feature requests from SQLite.
```

## 3. Planning Readiness Assessment

Before generating an executable backlog, the planner must assess whether there is enough information.

Readiness outcomes:

```text
sufficient
sufficient_with_assumptions
insufficient
```

Assessment records include readiness status, readiness score, blocking gaps, non-blocking gaps, assumptions, clarification questions, recommended next action, and backlog generation allowed flag.

Any blocking gap prevents activation unless resolved or explicitly accepted by an authorized human.

## 4. Clarification Workflow

Clarification is the structured workflow used to resolve missing, ambiguous, or risky requirements before backlog generation or activation.

Clarification statuses:

```text
clarification_not_required
clarification_required
clarification_in_progress
clarification_complete
clarification_blocked
```

Clarification records:

```text
clarification_sessions
clarification_questions
clarification_answers
clarification_gaps
clarification_assumptions
clarification_decisions
```

Clarification questions should be prioritized and limited. Recommended limit: 3 to 7 questions per clarification round.

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

If insufficient, generate clarification questions or a discovery backlog. Do not activate an executable backlog.

## 6. Trigger.dev Tasks

Planner tasks:

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

Trigger.dev manages retries, waitpoints, and long-running planner calls. SQLite remains authoritative.

## 7. Planner Agent Adapter

Planner work is performed through PlannerAgentAdapter.

Possible implementations include MockPlannerAdapter, GenericLLMPlannerAdapter, and HumanPlannerAdapter.

The planner adapter produces structured output, not final runtime state.

## 8. Output Records

The planner writes specification_inputs, planning_readiness_assessments, planning_gaps, planning_questions, planning_assumptions, clarification_sessions, clarification_questions, clarification_answers, implementation_plans, plan_sections, feature_requests, feature_dependencies, acceptance_criteria, test_expectations, human_approvals, workflow_events, agent_runs, cost_records, and artifact_exports.

## 9. Feature Request Quality Rules

A feature request must be small enough for one PR, large enough to be meaningful, independently reviewable, ordered by dependencies, explicit about acceptance criteria, explicit about test expectations, clear enough for a Coder Agent to implement, and clear enough for a Reviewer Agent to review.

## 10. Approval

Plans must be approved before execution.

Approval actions:

```text
approve
reject
request_revision
approve_with_assumptions
activate_for_execution
```

Activation changes features to `approved_pending_execution`.

## 11. Artifact Export/Import

`plan.md` and `backlog.md` are generated from SQLite.

Imports must follow: parse → validate → preview → approve → transactional SQLite import.

## 12. Acceptance Criteria

The Bootstrap Planner is complete when it can ingest user input, assess readiness, run clarification, generate structured plans and features, validate feature quality, require approval, activate approved features, and export/import Markdown artifacts safely.
