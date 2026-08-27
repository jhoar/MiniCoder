# MiniCoder — Glossary, Terms, and Canonical Vocabulary

> Status: Canonical
> Supersedes: (new — extracted as the single source of shared vocabulary)
> Version: 1.2.2
> Last-updated: 2026-08-27

This document is the single source of truth for state names, role names, adapter names, and the
CLI surface. Other canonical documents reference these terms; if a term appears elsewhere it must
match this file.

---

## 1. System Identity

- **MiniCoder** — Agentic Software Development Orchestration System.
- It converts user intent or system specifications into a clarified, approved, sequential
  implementation backlog, then orchestrates feature-branch development, pull requests, structured
  reviews, fixes, merge gates, and final design documentation.

Subsystem names:

- MiniCoder Bootstrap Planner
- MiniCoder Clarification Workflow
- MiniCoder Execution Orchestrator
- MiniCoder Agent Adapter Architecture
- MiniCoder Workflow Layer (implemented by an in-repo DB-backed task queue, `packages/triggerdev/` — formerly Trigger.dev)
- MiniCoder SCM Integration (`packages/github`, `packages/gitea`, `packages/gitlab` are all shipped
  `ScmClient` implementations — see `06-implementation-plan.md` §Phase 18; every write-path call
  site is provider-aware as of two same-day Stage 6 follow-ups except the coder adapter's own
  clone/push credential, a real, narrowly-tracked gap documented in that plan's Stage 6 completion
  notes)
- MiniCoder Orchestrator API
- MiniCoder Text UI
- MiniCoder Web UI
- MiniCoder Design Document Generator

---

## 2. Authority Boundaries (canonical)

```text
MiniCoder database = authoritative planning, backlog, workflow, testing, review, event,
                     agent-run, cost, artifact, and design-document state.
                     Local/single-node = SQLite on local disk. Hosted/team = PostgreSQL.
SCM provider       = authoritative repository, branch, commit, PR, review, CI/check,
                     conversation, mergeability, and merge state. GitHub (`OctokitGitHubClient`,
                     `packages/github`), Gitea (`GiteaScmClient`, `packages/gitea`), and GitLab
                     (`GitlabScmClient`, `packages/gitlab`) are all shipped `ScmClient`
                     implementations (see `06-implementation-plan.md` §Phase 18); every write-path
                     call site (scheduled reconciliation, reviewer diff fetch, merge-gate status
                     checks, PR creation, the real merge call) is provider-aware since Stage 6,
                     except the coder adapter's own clone/push credential — a real, narrowly-
                     tracked gap (Stage 6's completion notes).
SCM webhooks       = PRIMARY source for external SCM changes.
Scheduled reconciliation = fallback/repair mechanism. Implemented by the `github-reconciliation`
                     task (docs §3.12), which keeps that literal name regardless of which provider
                     it reconciles.
Workflow Layer     = durable workflow execution (tasks, retries, a polling queue); implemented by
                     an in-repo DB-backed task queue (formerly Trigger.dev), which is authoritative
                     only for task-execution run metadata (correlated via run IDs).
Orchestrator Core  = state machine, command handlers, policy checks, merge gates, database writes,
                     idempotency, and reconciliation.
Orchestrator API   = the only supported access path for the UIs.
Markdown artifacts = plan.md / backlog.md / final-design-document.md — generated/importable
                     snapshots, never runtime state.
```

Foundational rules:

- **Sequential execution is a policy setting, not a schema limitation.** It is enforced via
  workflow locks/leases and execution lanes, not a hard schema invariant.
- **Private chain-of-thought is never requested, captured, stored, or exposed.**
- **SQLite is never used over a network filesystem, shared persistent volume, or
  network-mounted database file.** Hosted/team deployments use PostgreSQL.

---

## 3. Lifecycle States (canonical, single list)

MiniCoder is modeled as **several distinct state machines**, not one: project, plan, feature
(execution), PR/review, agent run, workflow run, clarification session, artifact export, and budget
gate. The lists below are the canonical state tokens for each; the **state-transition matrix**
(§3.9) defines the allowed transitions, and feature-level execution (§3.2) is the primary
orchestration machine.

### 3.1 Planning lifecycle

```text
draft → pending_approval → approved → activated_for_execution
```

- `activated_for_execution` is the terminal planning state. Activation writes each generated
  feature request into the execution lifecycle at `approved_pending_execution` (see §3.2). The two
  names describe different entities: `activated_for_execution` is a _plan_ state;
  `approved_pending_execution` is the entry _feature_ state.

#### Project lifecycle

The project machine sits above plans and features:

```text
active → implementation_complete → design_document_generating
→ design_document_ready_for_review → design_document_approved → project_complete
```

Revision loop:

```text
design_document_ready_for_review → design_document_revision_requested
→ design_document_generating → design_document_ready_for_review
```

Preconditions: `active → implementation_complete` requires all approved features `merged` and
**Project Acceptance Validation** to pass (`01-system-specification.md` §13.1); the
design-document states are in §3.4; `project_complete` requires human approval of the final design
document. Allowed transitions, guards, and side effects are itemized in the state-transition matrix
(§3.9).

### 3.2 Execution lifecycle (per feature request)

```text
approved_pending_execution → selected → coding → code_pushed → pr_opened → ci_running
→ under_review → changes_requested → fixing → code_pushed → ci_running → under_review
→ approved_by_policy → merge_ready → merged
```

`approved_by_policy` is computed automatically by the merge gate; `merge_ready → merged` is
**initiated by an approver/admin via `merge-if-ready`** and the gate is re-evaluated immediately
before the SCM merge (see `01-system-specification.md` §12).

**Every new push re-enters CI.** A fix always flows `fixing → code_pushed → ci_running` before
returning to `under_review`; review and merge never act on un-tested code.

CI outcomes branch explicitly from `ci_running`:

```text
ci_running → [CI pass] → under_review
ci_running → [CI fail] → ci_failed → changes_requested → fixing
ci_failed  → human_required        (when review-cycle / fix-attempt limits are exceeded)
```

Merge can also fail **after** `merge_ready` (SCM-side merge rejection, a late conflict, changed
branch protection, or stale mergeability):

```text
merge_ready → [merge attempt fails] → merge_failed → reconcile
merge_failed → under_review     (when a re-push/re-check can clear it automatically)
merge_failed → human_required   (when it cannot be cleared automatically)
```

A CI failure never merges and never silently passes. The Execution Orchestrator records an
automated **blocking** review finding, routes the feature `ci_failed → changes_requested → fixing`
(re-using the review/fix loop and its limits in `01-system-specification.md` §5.8), and escalates to
`human_required` once those limits are exceeded.

**System-failure escape route.** On an infrastructure failure, sandbox crash, runner-node death, or
third-party/API timeout that exceeds retry thresholds during **any** active state, the Orchestrator
gracefully releases the feature's execution locks/leases, records `system_failed` with system
diagnostics, and transitions the feature to `human_required` — so an orphaned lock or stale lease
never leaves a feature branch permanently locked. Stale locks are also reclaimed by lease
expiry/reconciliation (`state doctor`).

**`human_required` exit dispositions (Phase 11).** Before Phase 11, `human_required` had no
outgoing transitions at all. Five commands now let a human disposition an escalated feature run —
`resolve, retry, skip, block, or resume` (§3.3):

```text
human_required → changes_requested   (ResolveDisagreementCommand — an open disagreement is
                                       dispositioned "fix required"; requires an open
                                       disagreement_records row)
human_required → under_review        (ResumeFeatureExecutionCommand — the escalation is dismissed,
                                       no fix needed)
human_required → selected            (RetryFeatureCommand — retry automation from the top; only
                                       valid when this run is still workflow_states.
                                       active_feature_run_id)
human_required → skipped             (SkipFeatureCommand — terminal; abandon automation for this
                                       feature)
human_required → blocked             (BlockFeatureCommand — human-initiated; distinct from the
                                       automatic blocked → approved_pending_execution path)
```

### 3.3 Failure / escalation states

```text
blocked           (non-terminal: a dependency/precondition is unmet — e.g. an unmet feature
                   dependency or unresolved blocking gap; clears automatically when the precondition
                   is satisfied, no human needed)
failed             (terminal for the current run/attempt: an operation exhausted its retries; the
                   feature does not advance and is escalated — failed always routes to human_required
                   for a human disposition: retry, skip, or block)
system_failed     (infrastructure/sandbox/timeout failure beyond retry thresholds; releases
                   locks/leases and escalates to human_required)
merge_failed       (a merge attempt failed after merge_ready; see §3.2 — auto-clears to under_review
                   or escalates to human_required)
human_required    (automation is intentionally stopped pending a human decision: resolve, retry,
                   skip, block, or resume; distinct from blocked, which needs no human)
skipped           (terminal — Phase 11: a human explicitly abandoned automation for this feature via
                   SkipFeatureCommand from human_required. Closed in issue #52:
                   SkipFeatureCommand now cascades — any feature run still at
                   approved_pending_execution that depends on the skipped one via
                   feature_dependencies is transitioned to blocked in the same command
                   (approved_pending_execution → blocked, triggered by SkipFeatureCommand),
                   surfacing the problem via existing blocked-state diagnostics instead of
                   silently stranding it forever. `state doctor`'s skipped_dependency check flags
                   any case that predates this fix as defense-in-depth.)
```

`ci_failed` (§3.2) is a feature-execution state, not a generic failure state.

### 3.4 Completion and design-document states

```text
implementation_complete
design_document_generating
design_document_ready_for_review
design_document_revision_requested
design_document_approved
project_complete
```

### 3.5 Readiness statuses

```text
sufficient
sufficient_with_assumptions
insufficient
```

### 3.6 Clarification statuses

```text
clarification_not_required
clarification_required
clarification_in_progress
clarification_complete
clarification_blocked
```

### 3.7 Review finding severities

```text
blocking                 (prevents merge until resolved)
non_blocking
question
nit
out_of_scope
requires_human_decision  (prevents merge until a human dispositions it; routes via human_required)
```

### 3.8 Automation control states (budget / pause gate)

These describe whether automation is permitted to advance; they are orthogonal to a feature's
execution state (a feature can sit at any execution state while automation is paused).

```text
running                      (automation advancing normally)
paused_by_operator           (a human paused via the pause command)
paused_budget_exceeded       (a hard budget limit halted automation)
waiting_for_budget_approval  (a soft limit reached; awaiting a budget-override approval)
```

A budget breach moves the project/feature to `paused_budget_exceeded` or
`waiting_for_budget_approval`; an approved budget override (or a human resume) returns it to
`running`. Resumption is recorded as a **`resumed` event / policy decision**, not a durable state.
See `01-system-specification.md` §5.11.

### 3.9 State-transition matrix

The lifecycle lists above enumerate _states_; the authoritative _transitions_ are specified as a
matrix. Each row has exactly these columns:

```text
from_state | to_state | triggering command/event | actor | guard condition
           | side effects | emitted events | idempotency key | recovery path
```

The canonical TypeScript source for all 8 machines lives in
`packages/core/src/statemachine/machines/`. Human-readable summaries follow.

#### Feature execution matrix (primary orchestration machine)

| from_state                   | to_state                     | command                            | actor    | guard                                                                                                                             |
| ---------------------------- | ---------------------------- | ---------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `approved_pending_execution` | `selected`                   | `SelectFeatureCommand`             | operator | automation=running; no active run; dependencies merged                                                                            |
| `selected`                   | `coding`                     | `StartCodingCommand`               | system   | lock held; valid fence                                                                                                            |
| `coding`                     | `code_pushed`                | `RecordCodePushedCommand`          | system   | lock held; commitSha provided                                                                                                     |
| `fixing`                     | `code_pushed`                | `RecordCodePushedCommand`          | system   | lock held; commitSha provided                                                                                                     |
| `code_pushed`                | `pr_opened`                  | `RecordPrOpenedCommand`            | system   | lock held; prNumber provided                                                                                                      |
| `pr_opened`                  | `ci_running`                 | `RecordCiRunningCommand`           | system   | lock held; checkRunId provided                                                                                                    |
| `ci_running`                 | `under_review`               | `RecordCiPassedCommand`            | system   | CI success                                                                                                                        |
| `ci_running`                 | `ci_failed`                  | `RecordCiFailedCommand`            | system   | CI failure                                                                                                                        |
| `ci_failed`                  | `changes_requested`          | `RequestChangesAfterCiFailCommand` | system   | fix-attempt < threshold                                                                                                           |
| `ci_failed`                  | `human_required`             | `EscalateToHumanCommand`           | system   | fix-attempt >= threshold; also GitHub reconciliation: PR closed unmerged (docs/01 §5.7)                                           |
| `under_review`               | `changes_requested`          | `RecordChangesRequestedCommand`    | system   | blocking findings; fix-attempt < threshold                                                                                        |
| `under_review`               | `human_required`             | `EscalateToHumanCommand`           | system   | requires_human_decision finding or limit exceeded; also GitHub reconciliation: PR closed unmerged (docs/01 §5.7)                  |
| `under_review`               | `approved_by_policy`         | `RecordApprovedByPolicyCommand`    | system   | merge gate passes                                                                                                                 |
| `changes_requested`          | `fixing`                     | `StartFixingCommand`               | system   | lock held; valid fence                                                                                                            |
| `approved_by_policy`         | `merge_ready`                | `MergeIfReadyCommand`              | approver | merge gate re-evaluated and passes                                                                                                |
| `merge_ready`                | `merged`                     | `RecordMergedCommand`              | system   | GitHub merge confirmed                                                                                                            |
| `merge_ready`                | `merge_failed`               | `RecordMergeFailedCommand`         | system   | GitHub merge rejected                                                                                                             |
| `merge_failed`               | `under_review`               | `ReconcileMergeFailedCommand`      | system   | auto-clearable failure                                                                                                            |
| `merge_failed`               | `human_required`             | `EscalateToHumanCommand`           | system   | cannot auto-clear; also GitHub reconciliation: PR closed unmerged (docs/01 §5.7)                                                  |
| `failed`                     | `human_required`             | `EscalateToHumanCommand`           | system   | retries exhausted                                                                                                                 |
| `system_failed`              | `human_required`             | `EscalateToHumanCommand`           | system   | infra failure; locks released; also GitHub reconciliation: PR closed unmerged (docs/01 §5.7)                                      |
| `blocked`                    | `approved_pending_execution` | `UnblockFeatureCommand`            | system   | all dependencies merged                                                                                                           |
| `approved_pending_execution` | `human_required`             | `EscalateToHumanCommand`           | system   | GitHub reconciliation: PR closed unmerged (docs/01 §5.7)                                                                          |
| `selected`                   | `human_required`             | `EscalateToHumanCommand`           | system   | GitHub reconciliation: PR closed unmerged (docs/01 §5.7)                                                                          |
| `coding`                     | `human_required`             | `EscalateToHumanCommand`           | system   | GitHub reconciliation: PR closed unmerged (docs/01 §5.7)                                                                          |
| `code_pushed`                | `human_required`             | `EscalateToHumanCommand`           | system   | GitHub reconciliation: PR closed unmerged (docs/01 §5.7)                                                                          |
| `pr_opened`                  | `human_required`             | `EscalateToHumanCommand`           | system   | GitHub reconciliation: PR closed unmerged (docs/01 §5.7)                                                                          |
| `ci_running`                 | `human_required`             | `EscalateToHumanCommand`           | system   | GitHub reconciliation: PR closed unmerged (docs/01 §5.7)                                                                          |
| `changes_requested`          | `human_required`             | `EscalateToHumanCommand`           | system   | GitHub reconciliation: PR closed unmerged (docs/01 §5.7)                                                                          |
| `fixing`                     | `human_required`             | `EscalateToHumanCommand`           | system   | GitHub reconciliation: PR closed unmerged (docs/01 §5.7)                                                                          |
| `approved_by_policy`         | `human_required`             | `EscalateToHumanCommand`           | system   | GitHub reconciliation: PR closed unmerged (docs/01 §5.7)                                                                          |
| `merge_ready`                | `human_required`             | `EscalateToHumanCommand`           | system   | GitHub reconciliation: PR closed unmerged (docs/01 §5.7)                                                                          |
| `human_required`             | `changes_requested`          | `ResolveDisagreementCommand`       | approver | an open disagreement_records row is dispositioned "fix required" (Phase 11)                                                       |
| `human_required`             | `under_review`               | `ResumeFeatureExecutionCommand`    | approver | escalation dismissed, no fix needed (Phase 11)                                                                                    |
| `human_required`             | `selected`                   | `RetryFeatureCommand`              | approver | retry from the top; run must still be workflow_states.active_feature_run_id (Phase 11)                                            |
| `human_required`             | `skipped`                    | `SkipFeatureCommand`               | approver | human abandons automation for this feature; terminal (Phase 11)                                                                   |
| `human_required`             | `blocked`                    | `BlockFeatureCommand`              | approver | human identifies an external precondition (Phase 11)                                                                              |
| `approved_pending_execution` | `blocked`                    | `SkipFeatureCommand`               | system   | cascading side effect: a dependency (feature_dependencies) was just skipped, which can never satisfy the merged guard (issue #52) |

#### Plan lifecycle matrix

| from_state         | to_state                  | command                        | actor    | guard                         |
| ------------------ | ------------------------- | ------------------------------ | -------- | ----------------------------- |
| `draft`            | `pending_approval`        | `SubmitPlanForApprovalCommand` | operator | plan generated; gaps resolved |
| `pending_approval` | `approved`                | `ApprovePlanCommand`           | approver | no unaccepted blocking gaps   |
| `approved`         | `activated_for_execution` | `ActivatePlanCommand`          | approver | all features executable       |

#### Project lifecycle matrix

| from_state                           | to_state                             | command                                | actor    | guard                           |
| ------------------------------------ | ------------------------------------ | -------------------------------------- | -------- | ------------------------------- |
| `active`                             | `implementation_complete`            | `MarkImplementationCompleteCommand`    | system   | all features merged; PAV passes |
| `implementation_complete`            | `design_document_generating`         | `GenerateDesignDocumentCommand`        | operator | —                               |
| `design_document_generating`         | `design_document_ready_for_review`   | `RecordDesignDocumentReadyCommand`     | system   | artifact exported               |
| `design_document_ready_for_review`   | `design_document_revision_requested` | `RequestDesignDocumentRevisionCommand` | approver | —                               |
| `design_document_revision_requested` | `design_document_generating`         | `RegenerateDesignDocumentCommand`      | operator | —                               |
| `design_document_ready_for_review`   | `design_document_approved`           | `ApproveDesignDocumentCommand`         | approver | —                               |
| `design_document_approved`           | `project_complete`                   | `CompleteProjectCommand`               | system   | —                               |

#### Automation control matrix

| from_state                    | to_state                      | command                              | actor    |
| ----------------------------- | ----------------------------- | ------------------------------------ | -------- |
| `running`                     | `paused_by_operator`          | `PauseAutomationCommand`             | operator |
| `paused_by_operator`          | `running`                     | `ResumeAutomationCommand`            | operator |
| `running`                     | `paused_budget_exceeded`      | `RecordBudgetExceededCommand`        | system   |
| `paused_budget_exceeded`      | `running`                     | `ApproveBudgetOverrideCommand`       | approver |
| `running`                     | `waiting_for_budget_approval` | `RecordBudgetApprovalWaitingCommand` | system   |
| `waiting_for_budget_approval` | `running`                     | `ApproveBudgetOverrideCommand`       | approver |

#### Agent run, workflow run, clarification, and artifact export matrices

Canonical source: `packages/core/src/statemachine/machines/{agent-run,workflow-run,clarification,artifact-export}.ts`.

Agent run: `queued → running → succeeded/failed/cancelled`; operator can cancel from queued or running.

Workflow run: `queued → running → waiting → running → succeeded/failed/cancelled`; operator can cancel from queued/running/waiting.

Clarification: `not_required → complete`; `required → in_progress → complete`; `in_progress → required` (next round); circuit-breaker: `in_progress/required → blocked` after 3 rounds.

Artifact export: `pending → generating → exported`; `generating → failed`; `exported → stale`; `stale/failed → generating` (re-trigger).

### 3.10 Subsystem record states

These belong to subsystem records, not the feature/project lifecycle, and are canonical tokens for
those records:

```text
agent_run_state       : queued | running | succeeded | failed | cancelled
workflow_run_state    : queued | running | waiting | succeeded | failed | cancelled
                        (correlated to task-queue run status; see triggerdev_runs)
pr_review_state       : none | pending | commented | changes_requested | approved | dismissed
                        (mirrors the SCM provider's review status; the SCM provider remains
                        authoritative. GitLab has no native "changes requested" state — a future
                        GitLab `ScmClient` implementation synthesizes it from approval count plus
                        unresolved blocking discussions; see `06-implementation-plan.md` §Phase 18)
artifact_export_state : pending | generating | exported | stale | failed
```

The feature execution machine (§3.2) references but does not duplicate these; e.g., a feature in
`under_review` has an associated `pr_review_state`.

### 3.11 Identifiers

Feature-request IDs are `FR-<zero-padded-int>` (e.g., `FR-002`), stable per project, and form the
feature branch suffix `minicoder/FR-<n>` (see `01-system-specification.md` §5.7).

### 3.12 Workflow Layer task IDs (exact strings — no drift permitted)

These are the canonical task identifiers registered in `packages/triggerdev/src/task-registry.ts`'s
`TASK_REGISTRY` (formerly `triggerdev-tasks.ts`'s `task({ id: ... })` calls) and exported via
`ALL_TASK_IDS`. They are used verbatim as both the task `id` field and in
`triggerdev_runs.triggerdev_task_id`. No renaming, abbreviation, or alternative spelling is permitted.

**Phase 3 initial subset** (shipped with Phase 3):

```text
planning-readiness-assessment
start-clarification
generate-implementation-plan
generate-feature-backlog
activate-approved-backlog
start-next-feature
github-reconciliation
export-plan
export-backlog
```

**Phase 6 additions** (Bootstrap Planner tasks — shipped with Phase 6):

```text
ingest-specification
record-clarification-answer
complete-clarification
validate-backlog
request-plan-approval
import-backlog
```

**Phase 9 addition** (Reference Coder Adapter — shipped with Phase 9):

```text
run-coder
```

**Phase 10 addition** (Reference Reviewer Adapter and Review/Fix Loop — shipped with Phase 10):

```text
run-review
```

**Phase 12 addition** (Merge Gate and Branch Protection — shipped with Phase 12):

```text
run-merge-gate
```

**Phase 17 addition** (Final Design Document Generator — shipped with Phase 17):

```text
run-design-doc
```

---

## 4. Agent Roles and Adapters (canonical names)

### 4.1 Roles (interfaces)

- `PlannerAgentAdapter`
- `CoderAgentAdapter`
- `ReviewerAgentAdapter`
- `ArbiterAgentAdapter`
- `DocumentationAgentAdapter`
- `HumanAgentAdapter` — represents real manual approval / fallback / human-required decisions.

### 4.2 Deterministic mocks (test implementations)

- `MockPlannerAdapter`
- `MockCoderAdapter`
- `MockReviewerAdapter`
- `MockArbiterAdapter`
- `MockDocumentationAdapter`
- `HumanTestAdapter` — the deterministic test mock of `HumanAgentAdapter`.

### 4.3 Reference (provider) adapters

`GenericLLMPlannerAdapter`, `CodexCoderAdapter`, `ClaudeReviewerAdapter`, `ClaudeArbiterAdapter`,
`GenericLLMDocumentationAdapter`. Reference implementations only — never architectural dependencies.
`ClaudeArbiterAdapter` (issue #51, `packages/adapters-arbiter`) is a sandbox-free
`ArbiterAgentAdapter` implementation against the existing `ArbiterInput`/`ArbiterOutput` contract,
mirroring `ClaudeReviewerAdapter`'s shape.

### 4.4 User / Auth roles (canonical)

Distinct from the agent roles above; these are the human/API authorization roles, authoritative
here and referenced by the UI and security specs:

```text
viewer    | operator | approver | admin
```

- **viewer:** read-only.
- **operator:** viewer + may issue non-guarded commands (start next feature, request coder/review
  run, recompute merge gate, reconcile, export artifacts). Cannot activate plans, override budgets,
  resolve disagreements, merge-if-ready, approve design docs, or run guarded/destructive lifecycle
  actions.
- **approver / admin:** operator + the guarded actions below.

`approver`/`admin` are required for plan activation, budget override, disagreement resolution,
merge-if-ready, final design-document approval, and guarded state-lifecycle/destructive actions.

---

## 5. Canonical CLI Surface

Superset of all lifecycle/test tooling. Subsystem docs reference these; none introduce commands
absent here.

```bash
# Database lifecycle
minicoder db migrate
minicoder db rollback
minicoder db reset
minicoder db seed
minicoder db snapshot
minicoder db restore
minicoder db validate
minicoder db diff
minicoder db status

# Workflow Layer / task-queue lifecycle (formerly "Trigger.dev lifecycle" — Trigger.dev has been
# replaced by an in-repo DB-backed task queue; see CLAUDE.md's "Task Worker Operational
# Constraints" section)
minicoder trigger deploy
minicoder trigger list-runs
minicoder trigger inspect-run
minicoder trigger cancel-run
minicoder trigger replay-run
minicoder trigger drain-queue
minicoder trigger reset-dev
minicoder trigger validate
minicoder trigger reconcile
minicoder tasks worker [--poll-interval-ms <ms>] [--batch-size <n>] [--stale-claim-ms <ms>]  # long-running: polls task_queue and executes claimed tasks until terminated
minicoder tasks drain [--timeout-ms <ms>] [--poll-interval-ms <ms>]                          # one-shot: waits for task_queue to empty (CI/test use)

# Workflow / state lifecycle
minicoder state inspect
minicoder state validate
minicoder state reconcile --project <id>               # project-scoped (stale locks only)
minicoder state reconcile --all                        # global (stale locks + stuck queues)
minicoder state doctor
minicoder state doctor --check-scm                     # opt-in; requires a provider credential (GITHUB_TOKEN/GITEA_TOKEN/GITLAB_TOKEN) (issue #35, generalized in Stage 5)
minicoder state doctor --check-github                  # deprecated alias for --check-scm, kept for backward compatibility
minicoder state export-diagnostics
minicoder state repair --project <id> --dry-run        # preview only (non-destructive; --project required)
minicoder state repair --project <id> --apply --confirmation <token>  # guarded destructive apply

# GitHub simulation (test/dev only)
minicoder github simulate-pr-opened
minicoder github simulate-pr-closed
minicoder github simulate-pr-merged
minicoder github simulate-check-passed
minicoder github simulate-check-failed
minicoder github simulate-review-approved
minicoder github simulate-review-changes-requested
minicoder github simulate-branch-protection-ok

# GitHub webhook receiver (Phase 7; not env-guarded — intended for real deployments)
minicoder github serve                                  # POST /webhooks/github; standalone Fastify app

# Gitea simulation (test/dev only) — docs/06 §Phase 18 Stage 3; mirrors the GitHub group above,
# minus simulate-branch-protection-ok (no Gitea equivalent — that command is GitHub-only
# dev-tooling with no real webhook event behind it even on the GitHub side)
minicoder gitea simulate-pr-opened
minicoder gitea simulate-pr-closed
minicoder gitea simulate-pr-merged
minicoder gitea simulate-check-passed
minicoder gitea simulate-check-failed
minicoder gitea simulate-review-approved
minicoder gitea simulate-review-changes-requested

# Gitea webhook receiver (docs/06 §Phase 18 Stage 3; not env-guarded, same posture as `github serve`)
minicoder gitea serve                                   # POST /webhooks/gitea; standalone Fastify app

# GitLab simulation (test/dev only) — docs/06 §Phase 18 Stage 4; mirrors the GitHub/Gitea groups
# above, minus simulate-review-changes-requested (GitLab has no webhook event for a discrete
# "changes requested" review action, and no inbox handler is registered for it on this provider —
# see @minicoder/gitlab's normalize.ts) and simulate-branch-protection-ok (no GitLab equivalent,
# same reason as Gitea's)
minicoder gitlab simulate-pr-opened
minicoder gitlab simulate-pr-closed
minicoder gitlab simulate-pr-merged
minicoder gitlab simulate-check-passed
minicoder gitlab simulate-check-failed
minicoder gitlab simulate-review-approved

# GitLab webhook receiver (docs/06 §Phase 18 Stage 4; not env-guarded, same posture as `github serve`)
minicoder gitlab serve                                  # POST /webhooks/gitlab; standalone Fastify app

# Human escalation disposition (Phase 11; human_required exit commands)
minicoder human resolve-disagreement --feature-run <id> --project <id> --actor <id> --resolution <text> [--disagreement <id>]
minicoder human resume --feature-run <id> --project <id> --actor <id> --notes <text> [--disagreement <id>]
minicoder human retry --feature-run <id> --project <id> --actor <id> --notes <text>
minicoder human skip --feature-run <id> --project <id> --actor <id> --notes <text>
minicoder human block --feature-run <id> --project <id> --actor <id> --notes <text>
minicoder human unblock --feature-run <id> --project <id> --actor <id> --notes <text>

# Merge Gate (Phase 12; approver/admin-initiated merge)
minicoder merge merge-if-ready --feature-run <id> --project <id> --actor <id> [--actor-role approver] [--merge-method squash|merge|rebase]
minicoder merge finalize-if-github-merged --feature-run <id> --project <id>   # issue #56 recovery path

# Plan/backlog artifact import (issue #33)
minicoder plan import-backlog <file> --project <id> --plan <id> --actor <id> [--actor-role approver] [--dry-run]

# Orchestrator API (Phase 13; read/command/webhook endpoints — see 01-system-specification.md §9)
minicoder api serve [--port <number>] [--host <host>]   # long-running Fastify process

# Ink Text UI (Phase 14; API-only — see 05-ui-specification.md §4). Each renders once and exits;
# every command accepts --json to print the raw API response instead of the Ink-rendered view.
# Requires MINICODER_API_URL (default http://localhost:4000) and MINICODER_API_KEY (client-side,
# singular — distinct from the server's plural MINICODER_API_KEYS; see docs/07 §4).
minicoder status --project <id>
minicoder plan --project <id>                           # default view; `plan import-backlog` unchanged
minicoder clarification --project <id> [--session <id>]
minicoder features --project <id> [--human-required] [--cursor <c>] [--limit <n>]
minicoder active --project <id>
minicoder runs [--project <id>] [--feature-run <id>] [--cursor <c>] [--limit <n>]
minicoder runs --timeline <featureRunId>                # Phase 16: merged workflow-history view
minicoder findings --feature-run <id> [--cursor <c>] [--limit <n>]
minicoder disagreements [--feature-run <id>] [--state <state>] [--cursor <c>] [--limit <n>]
minicoder costs --project <id>
minicoder costs --project <id> --report [--window-days <n>]  # Phase 16: aggregate spend breakdown
minicoder artifacts --project <id> [--cursor <c>] [--limit <n>]
minicoder adapters [--adapter <id>]
minicoder design-doc --project <id> [--document <id>]
minicoder pause --project <id> --yes                    # running -> paused_by_operator (operator+)
minicoder resume --project <id> --yes                   # paused_by_operator -> running (operator+)

# Final Design Document Generator (Phase 17; project-lifecycle write actions — docs/01 §13)
minicoder project mark-implementation-complete --project <id> --evidence <ci-run-url-or-signoff> --yes   # active -> implementation_complete (system-gated by Project Acceptance Validation)
minicoder project validate-acceptance --project <id>                  # inspects Project Acceptance Validation without transitioning
minicoder project complete --project <id> --yes                       # design_document_approved -> project_complete
minicoder design-doc generate --project <id> --yes                            # implementation_complete -> design_document_generating (operator+)
minicoder design-doc regenerate --project <id> --yes                          # design_document_revision_requested -> design_document_generating (operator+)
minicoder design-doc request-revision --project <id> --document <id> --yes [--notes <text>]  # -> design_document_revision_requested (approver+)
minicoder design-doc approve --project <id> --document <id> --yes [--notes <text>]           # -> design_document_approved (approver+)
minicoder design-doc request-run --project <id> --documentation-adapter <name> [--idempotency-key <key>] # enqueues run-design-doc (drafts sections, exports final-design-document.md)

# Generic-dispatch and task-enqueue CLI wrappers (previously curl-only — see USER-MANUAL.md §5.0/
# §5.0.1; API-only, same conventions as the Ink Text UI commands above). Every write/enqueue
# command below also accepts an optional --idempotency-key <key> to reuse a specific key (for
# safely retrying after a timeout/lost response) instead of minting a fresh one per invocation.
minicoder spec ingest <file> --project <id> [--content-type <type>]           # operator+
minicoder clarification answer --project <id> --session <id> --question <id> --text <answer>  # operator+
minicoder plan submit-for-approval --project <id> --plan <id>                 # operator+; draft -> pending_approval
minicoder plan approve --project <id> --plan <id> --yes [--notes <text>]      # approver+; pending_approval -> approved
minicoder plan activate --project <id> --plan <id> --yes                     # approver+; approved -> activated_for_execution
minicoder budget approve-override --project <id> --policy <id> --reason <text> --yes  # approver+
minicoder run coder --project <id> --feature-run <id> --coder-adapter <name>          # operator+; enqueues run-coder
minicoder run review --project <id> --feature-run <id> --reviewer-adapter <name> [--arbiter-adapter <name>]  # operator+; enqueues run-review
minicoder run fixes --project <id> --feature-run <id> --reviewer-adapter <name>       # operator+; re-enqueues run-review
minicoder run merge-gate --project <id> --feature-run <id>                            # operator+; enqueues run-merge-gate

# Observability export (issue #67; optional, DB-direct — not the Ink Text UI's API-only surface)
minicoder observability export-otel [--cursor-id <id>] [--limit <n>]  # exports workflow_events to
  # OTEL_EXPORTER_OTLP_ENDPOINT if configured (no-ops otherwise); resumes from a durable cursor
  # (observability_export_cursors); intended for invocation by an external scheduler (cron, k8s
  # CronJob) rather than an always-on Workflow Layer task

# Next.js Web UI (Phase 15; browser-based, API-only — see 05-ui-specification.md §5 for the full
# 17-route list). Not a CLI surface — `packages/web`'s Next.js server process reads the same
# MINICODER_API_URL/MINICODER_API_KEY env vars the Ink Text UI above already uses; no new
# WEB_*-prefixed variant was introduced.

# Test scenario runner (non-zero exit on failure)
minicoder test unit
minicoder test integration
minicoder test system
minicoder test scenario planning-basic
minicoder test scenario clarification-required
minicoder test scenario backlog-activation
minicoder test scenario review-loop
minicoder test scenario merge-gate
minicoder test scenario trigger-retry
minicoder test scenario github-race
minicoder test scenario final-design-document
minicoder test scenario execution-orchestrator
minicoder test scenario coder-adapter-run
minicoder test scenario review-fix-loop
minicoder test scenario disagreement-arbiter
minicoder test scenario design-document-lifecycle
```

Destructive commands (`db reset`, `trigger reset-dev`, `state repair --apply`) require an
environment check, role/permission check, dry-run where possible, explicit confirmation flag, and
an audit event. Production destructive operations are disallowed unless implemented as guarded
safe-maintenance workflows.

Dev/test-only mutating commands (`db seed`, `db restore`, `github simulate-*`) reject immediately
if `APP_ENV` or `NODE_ENV` is `'production'` — this check cannot be overridden by `--env`.

The `state repair --apply` confirmation token is **issued by `state repair --dry-run`** (which
prints it alongside the planned changes), is **single-use**, **time-boxed** (5-minute expiry),
bound to the `--project <id>` that issued it, and its issuance and use are audited. `--project`
is mandatory for both `--dry-run` and `--apply`.

---

## 6. Deployment Profiles

Deployment has one primary axis: the **state store**. The Workflow Layer execution backend
(`packages/triggerdev/`) is an in-repo, DB-backed task queue with no external service and no
separate deployment-tier decision — it reads/writes the same database the rest of the deployment
already uses, so there is nothing to choose beyond "how many `minicoder tasks worker` processes to
run." **Superseded, kept for historical context:** this subsystem was originally built on
Trigger.dev, which did have a genuine second deployment axis (self-host single-node vs. self-host
HA cluster vs. Trigger.dev Cloud) — that entire axis is gone along with the Trigger.dev dependency.

### 6.1 State store

- **Local / Single-Node** — SQLite on local disk; local API; local TUI; optional local Web UI.
- **Hosted / Team** — PostgreSQL; hosted API; Web UI; a token-based SCM credential per provider
  (GitHub App/PAT, Gitea token, GitLab token — `06-implementation-plan.md` §Phase 18; real
  end-user OAuth/SSO session auth is deferred future work regardless of provider, docs/07 §4);
  SCM webhooks.

### 6.2 Workflow Layer execution: `minicoder tasks worker`

- **Single process (default)** — one `minicoder tasks worker` process polling `task_queue` against
  the same database the API/CLI use. Pairs naturally with either state-store profile.
- **Multiple processes (scale option)** — run additional `minicoder tasks worker` processes against
  the same database to increase throughput; `TaskQueueDispatcher`'s atomic optimistic-lock claim
  (`UPDATE ... WHERE status IN (...) AND version = ?`) makes concurrent workers safe by
  construction, the same guarantee `packages/workflow`'s `OutboxDispatcher` already relies on for
  outbox/inbox draining. There is no Cloud/hosted-SaaS option and no payload-boundary question:
  task payloads never leave the deployment's own database.

---

## 7. Technology Stack (locked)

```text
Language:          TypeScript
Runtime:           Node.js
Package manager:   pnpm
Local/single-node DB: SQLite
Hosted/team DB:    PostgreSQL
Validation:        Zod
Testing:           Vitest
GitHub API:        Octokit
Workflow execution: In-repo DB-backed task queue (packages/triggerdev/) — formerly Trigger.dev
API framework:     Fastify
Text UI:           Ink
Web UI:            React / Next.js
Security scanning: dependency audit (pnpm audit / OSV) + secret scan (gitleaks) + SAST (semgrep)
```
