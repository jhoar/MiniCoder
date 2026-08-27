# MiniCoder — Entity Relationship Diagram

> Status: Canonical
> Supersedes: (none — new in Phase 1)
> Version: 1.2.0
> Last-updated: 2026-06-12

This document is the authoritative ERD for the MiniCoder database schema introduced in Phase 1.
It must remain in sync with `packages/migrations/migrations/0001_initial_schema.*.sql`.
State names match `00-glossary-and-terms.md`; adapter names match `03-agent-adapter-architecture.md`.

---

## Relationship Overview

```
projects (1) ──< repositories (*)
projects (1) ──< scm_links (*)
projects (1) ──< specification_inputs (*)
projects (1) ──< planning_readiness_assessments (*)
projects (1) ── workflow_states (1)          [UNIQUE project_id]
projects (1) ──< implementation_plans (*)
projects (1) ──< feature_requests (*)        [via plan]
projects (1) ──< workflow_events (*)
projects (1) ──< workflow_locks (*)
projects (1) ──< human_approvals (*)
projects (1) ──< policy_decisions (*)
projects (1) ──< budget_policies (*)
projects (1) ──< cost_records (*)
projects (1) ──< artifact_exports (*)
projects (1) ──< design_documents (*)
projects (1) ──< design_decisions (*)
projects (1) ──< glossary_terms (*)

planning_readiness_assessments (1) ──< planning_gaps (*)
planning_readiness_assessments (1) ──< planning_questions (*)
planning_readiness_assessments (1) ──< planning_assumptions (*)

implementation_plans (1) ──< plan_sections (*)
implementation_plans (1) ──< feature_requests (*)

feature_requests (M) ──< feature_dependencies (M)   [DAG edge table]
feature_requests (1) ──< acceptance_criteria (*)
feature_requests (1) ──< test_expectations (*)
feature_requests (1) ──< feature_runs (*)
feature_requests (1) ──< budget_policies (*)         [feature-scope only]
feature_requests (1) ──< cost_records (*)

feature_runs (1) ──< workflow_events (*)
feature_runs (1) ──< agent_runs (*)
feature_runs (1) ──< review_findings (*)
feature_runs (1) ──< disagreement_records (*)
feature_runs (1) ──< merge_gate_evaluations (*)
feature_runs (1) ──< human_approvals (*)
feature_runs (1) ──< policy_decisions (*)
feature_runs (1) ──< cost_records (*)
feature_runs (0..1) ── workflow_locks              [lock lease via lock_id]
feature_runs (0..1) ── triggerdev_runs

agent_adapters (1) ──< agent_capabilities (*)
agent_adapters (1) ──< agent_configurations (*)
agent_adapters (1) ──< agent_runs (*)
agent_adapters (1) ──< adapter_conformance_results (*)

agent_runs (1) ──< agent_errors (*)
agent_runs (1) ──< agent_tool_operations (*)
agent_runs (1) ──< agent_context_packs (*)

review_findings (1) ──< coder_responses (*)
review_findings (1) ──< disagreement_records (*)

design_documents (1) ──< design_document_sections (*)  [UNIQUE per section_name]
design_documents (1) ──< design_decisions (*)

outbox_events  — standalone (no FK; decoupled delivery)
inbox_events   — standalone (dedup_key UNIQUE index; GitHub X-GitHub-Delivery GUID)
idempotency_keys — standalone ((key, scope) UNIQUE; expires_at index for TTL sweep)
```

---

## Column Convention Exceptions

The canonical schema contract (§8 of `01-system-specification.md`) requires every table to carry
`version`, `created_at`, and `updated_at`. The following tables are explicitly exempt because their
rows are immutable once written:

| Table                         | Category                | Has `created_at` | Has `version`/`updated_at`                                                  |
| ----------------------------- | ----------------------- | ---------------- | --------------------------------------------------------------------------- |
| `workflow_events`             | Append-only event log   | ✓                | — rows are never mutated                                                    |
| `agent_errors`                | Immutable audit record  | ✓                | — point-in-time observation                                                 |
| `agent_tool_operations`       | Immutable audit record  | ✓                | — point-in-time observation                                                 |
| `adapter_conformance_results` | Immutable test snapshot | ✓                | — completed run result                                                      |
| `feature_dependencies`        | Link / edge table       | ✓                | — created/deleted atomically; owning `feature_requests` carries the version |

All other tables — including `outbox_events`, `inbox_events`, and `idempotency_keys` — carry
`version` and `updated_at` because fields are mutated after initial insert.

---

## Table Definitions

### projects

| Column      | Type (SQLite / PG) | Constraints               |
| ----------- | ------------------ | ------------------------- |
| id          | TEXT / TEXT        | PRIMARY KEY               |
| name        | TEXT / TEXT        | NOT NULL                  |
| description | TEXT / TEXT        | nullable                  |
| state       | TEXT / TEXT        | NOT NULL DEFAULT 'active' |
| version     | INTEGER / INTEGER  | NOT NULL DEFAULT 1        |
| created_at  | TEXT / TIMESTAMPTZ | NOT NULL DEFAULT now()    |
| updated_at  | TEXT / TIMESTAMPTZ | NOT NULL DEFAULT now()    |

Indexes: `state`.
State values: `active → implementation_complete → design_document_generating →
design_document_ready_for_review → design_document_revision_requested →
design_document_approved → project_complete` (§3.1 glossary).

---

### repositories

> Migration `0018` (docs/06 §Phase 18 Stage 2, "Generic SCM Interface") added `provider` and
> `base_url` to this table, originally introduced by Phase 1's `0001_initial_schema`. This ERD is
> updated to reflect that.

| Column                  | Type      | Constraints                                                 |
| ----------------------- | --------- | ----------------------------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                                                 |
| project_id              | TEXT      | NOT NULL FK projects                                        |
| owner                   | TEXT      | NOT NULL                                                    |
| name                    | TEXT      | NOT NULL                                                    |
| full_name               | TEXT      | NOT NULL (owner/name)                                       |
| default_branch          | TEXT      | NOT NULL DEFAULT 'main'                                     |
| provider                | TEXT      | NOT NULL DEFAULT 'github' (`github` \| `gitea` \| `gitlab`) |
| base_url                | TEXT      | nullable (self-hosted instance URL; NULL for GitHub)        |
| version                 | INTEGER   | NOT NULL DEFAULT 1                                          |
| created_at / updated_at | timestamp | NOT NULL                                                    |

Indexes: `project_id`, `(full_name, provider)`.

---

### scm_links

> Renamed from `github_links` by migration `0018` (docs/06 §Phase 18 Stage 2) — the table itself
> was already provider-neutral (only `installation_id`/`app_id` are GitHub-App-specific, and are
> simply left unpopulated by a Gitea/GitLab-linked row); only the name changed.

| Column                  | Type      | Constraints                           |
| ----------------------- | --------- | ------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                           |
| project_id              | TEXT      | NOT NULL FK projects                  |
| repository_id           | TEXT      | nullable FK repositories              |
| installation_id         | TEXT      | nullable (GitHub App installation ID) |
| app_id                  | TEXT      | nullable                              |
| linked_at               | timestamp | NOT NULL                              |
| version                 | INTEGER   | NOT NULL DEFAULT 1                    |
| created_at / updated_at | timestamp | NOT NULL                              |

Indexes: `project_id`.

---

---

### specification_inputs

| Column                  | Type      | Constraints                   |
| ----------------------- | --------- | ----------------------------- |
| id                      | TEXT      | PRIMARY KEY                   |
| project_id              | TEXT      | NOT NULL FK projects          |
| content                 | TEXT      | NOT NULL                      |
| content_type            | TEXT      | NOT NULL DEFAULT 'text/plain' |
| version                 | INTEGER   | NOT NULL DEFAULT 1            |
| created_at / updated_at | timestamp | NOT NULL                      |

Indexes: `project_id`.

---

### planning_readiness_assessments

| Column                  | Type      | Constraints                                                        |
| ----------------------- | --------- | ------------------------------------------------------------------ |
| id                      | TEXT      | PRIMARY KEY                                                        |
| project_id              | TEXT      | NOT NULL FK projects                                               |
| specification_input_id  | TEXT      | nullable FK specification_inputs                                   |
| status                  | TEXT      | NOT NULL (sufficient / sufficient_with_assumptions / insufficient) |
| summary                 | TEXT      | nullable                                                           |
| version                 | INTEGER   | NOT NULL DEFAULT 1                                                 |
| created_at / updated_at | timestamp | NOT NULL                                                           |

Indexes: `project_id`.

---

### planning_gaps

| Column                  | Type      | Constraints                                |
| ----------------------- | --------- | ------------------------------------------ |
| id                      | TEXT      | PRIMARY KEY                                |
| assessment_id           | TEXT      | NOT NULL FK planning_readiness_assessments |
| description             | TEXT      | NOT NULL                                   |
| severity                | TEXT      | NOT NULL (blocking / non_blocking)         |
| resolution              | TEXT      | nullable                                   |
| resolved_at             | timestamp | nullable                                   |
| version                 | INTEGER   | NOT NULL DEFAULT 1                         |
| created_at / updated_at | timestamp | NOT NULL                                   |

Indexes: `assessment_id`.

---

### planning_questions

| Column                  | Type      | Constraints                                |
| ----------------------- | --------- | ------------------------------------------ |
| id                      | TEXT      | PRIMARY KEY                                |
| assessment_id           | TEXT      | NOT NULL FK planning_readiness_assessments |
| question                | TEXT      | NOT NULL                                   |
| answer                  | TEXT      | nullable                                   |
| answered_at             | timestamp | nullable                                   |
| round                   | INTEGER   | NOT NULL DEFAULT 1                         |
| version                 | INTEGER   | NOT NULL DEFAULT 1                         |
| created_at / updated_at | timestamp | NOT NULL                                   |

Indexes: `assessment_id`.

---

### planning_assumptions

| Column                  | Type      | Constraints                                     |
| ----------------------- | --------- | ----------------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                                     |
| assessment_id           | TEXT      | NOT NULL FK planning_readiness_assessments      |
| description             | TEXT      | NOT NULL                                        |
| confidence              | TEXT      | NOT NULL DEFAULT 'medium' (high / medium / low) |
| version                 | INTEGER   | NOT NULL DEFAULT 1                              |
| created_at / updated_at | timestamp | NOT NULL                                        |

Indexes: `assessment_id`.

---

### implementation_plans

| Column                  | Type      | Constraints                                |
| ----------------------- | --------- | ------------------------------------------ |
| id                      | TEXT      | PRIMARY KEY                                |
| project_id              | TEXT      | NOT NULL FK projects                       |
| assessment_id           | TEXT      | nullable FK planning_readiness_assessments |
| state                   | TEXT      | NOT NULL DEFAULT 'draft'                   |
| title                   | TEXT      | NOT NULL                                   |
| summary                 | TEXT      | nullable                                   |
| version                 | INTEGER   | NOT NULL DEFAULT 1                         |
| created_at / updated_at | timestamp | NOT NULL                                   |

Indexes: `project_id`, `state`.
State values: `draft → pending_approval → approved → activated_for_execution`.

---

### plan_sections

| Column                  | Type      | Constraints                      |
| ----------------------- | --------- | -------------------------------- |
| id                      | TEXT      | PRIMARY KEY                      |
| plan_id                 | TEXT      | NOT NULL FK implementation_plans |
| title                   | TEXT      | NOT NULL                         |
| content                 | TEXT      | NOT NULL                         |
| order_index             | INTEGER   | NOT NULL DEFAULT 0               |
| version                 | INTEGER   | NOT NULL DEFAULT 1               |
| created_at / updated_at | timestamp | NOT NULL                         |

Indexes: `plan_id`.

---

### feature_requests

| Column                  | Type      | Constraints                                      |
| ----------------------- | --------- | ------------------------------------------------ |
| id                      | TEXT      | PRIMARY KEY                                      |
| plan_id                 | TEXT      | NOT NULL FK implementation_plans                 |
| project_id              | TEXT      | NOT NULL FK projects                             |
| fr_id                   | TEXT      | NOT NULL (e.g. `FR-002`)                         |
| title                   | TEXT      | NOT NULL                                         |
| description             | TEXT      | NOT NULL                                         |
| kind                    | TEXT      | NOT NULL DEFAULT 'feature' (feature / discovery) |
| executable              | BOOL/INT  | NOT NULL DEFAULT true                            |
| state                   | TEXT      | NOT NULL DEFAULT 'approved_pending_execution'    |
| priority                | INTEGER   | NOT NULL DEFAULT 0                               |
| version                 | INTEGER   | NOT NULL DEFAULT 1                               |
| created_at / updated_at | timestamp | NOT NULL                                         |

Unique: `(project_id, fr_id)`.
Indexes: `project_id`, `state`, `plan_id`.
State values: see §3.2 glossary (approved_pending_execution → selected → coding → … → merged).
Discovery features (`kind='discovery'`) are never directly executable.

---

### feature_dependencies

**Exception: link table — no `version`/`updated_at`.** Rows are created or deleted atomically;
the owning `feature_requests` row carries the version for optimistic concurrency.

| Column       | Type      | Constraints                  |
| ------------ | --------- | ---------------------------- |
| id           | TEXT      | PRIMARY KEY                  |
| source_fr_id | TEXT      | NOT NULL FK feature_requests |
| target_fr_id | TEXT      | NOT NULL FK feature_requests |
| created_at   | timestamp | NOT NULL                     |

Unique: `(source_fr_id, target_fr_id)`.
Indexes: `source_fr_id`, `target_fr_id`.
Semantics: source depends on target (target must be merged before source can execute).

---

### acceptance_criteria

| Column                  | Type      | Constraints                  |
| ----------------------- | --------- | ---------------------------- |
| id                      | TEXT      | PRIMARY KEY                  |
| feature_request_id      | TEXT      | NOT NULL FK feature_requests |
| description             | TEXT      | NOT NULL                     |
| order_index             | INTEGER   | NOT NULL DEFAULT 0           |
| version                 | INTEGER   | NOT NULL DEFAULT 1           |
| created_at / updated_at | timestamp | NOT NULL                     |

Indexes: `feature_request_id`.

---

### test_expectations

| Column                  | Type      | Constraints                            |
| ----------------------- | --------- | -------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                            |
| feature_request_id      | TEXT      | NOT NULL FK feature_requests           |
| description             | TEXT      | NOT NULL                               |
| test_type               | TEXT      | nullable (unit / integration / system) |
| order_index             | INTEGER   | NOT NULL DEFAULT 0                     |
| version                 | INTEGER   | NOT NULL DEFAULT 1                     |
| created_at / updated_at | timestamp | NOT NULL                               |

Indexes: `feature_request_id`.

---

### workflow_states

| Column                  | Type      | Constraints                           |
| ----------------------- | --------- | ------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                           |
| project_id              | TEXT      | NOT NULL UNIQUE FK projects           |
| active_feature_run_id   | TEXT      | nullable (current active run pointer) |
| automation_state        | TEXT      | NOT NULL DEFAULT 'running'            |
| version                 | INTEGER   | NOT NULL DEFAULT 1                    |
| created_at / updated_at | timestamp | NOT NULL                              |

One row per project (UNIQUE project_id).
Automation state values: `running / paused_by_operator / paused_budget_exceeded / waiting_for_budget_approval`.

---

### feature_runs

| Column                  | Type      | Constraints                                               |
| ----------------------- | --------- | --------------------------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                                               |
| feature_request_id      | TEXT      | NOT NULL FK feature_requests                              |
| attempt_no              | INTEGER   | NOT NULL DEFAULT 1                                        |
| current_execution_state | TEXT      | NOT NULL DEFAULT 'approved_pending_execution'             |
| lock_id                 | TEXT      | nullable (FK workflow_locks — lock held during execution) |
| started_at              | timestamp | nullable                                                  |
| ended_at                | timestamp | nullable                                                  |
| outcome                 | TEXT      | nullable (succeeded / failed / cancelled)                 |
| version                 | INTEGER   | NOT NULL DEFAULT 1                                        |
| created_at / updated_at | timestamp | NOT NULL                                                  |

Indexes: `feature_request_id`, `current_execution_state`.

---

### workflow_events

**Exception: append-only event log — no `version`/`updated_at`.** Each row records a past state
transition and is never mutated after insert.

| Column                 | Type       | Constraints              |
| ---------------------- | ---------- | ------------------------ |
| id                     | TEXT       | PRIMARY KEY              |
| feature_run_id         | TEXT       | nullable FK feature_runs |
| project_id             | TEXT       | NOT NULL FK projects     |
| event_type             | TEXT       | NOT NULL                 |
| from_state             | TEXT       | nullable                 |
| to_state               | TEXT       | nullable                 |
| actor                  | TEXT       | nullable                 |
| payload                | TEXT/JSONB | nullable                 |
| payload_schema_version | TEXT       | NOT NULL DEFAULT '1.0.0' |
| occurred_at            | timestamp  | NOT NULL                 |
| created_at             | timestamp  | NOT NULL                 |

Append-only. Indexes: `project_id`, `feature_run_id`, `occurred_at`.

---

### workflow_locks

| Column                  | Type      | Constraints                                       |
| ----------------------- | --------- | ------------------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                                       |
| project_id              | TEXT      | NOT NULL FK projects                              |
| resource_key            | TEXT      | NOT NULL                                          |
| holder_id               | TEXT      | NOT NULL                                          |
| fence                   | INTEGER   | NOT NULL (monotonically increasing fencing token) |
| acquired_at             | timestamp | NOT NULL                                          |
| expires_at              | timestamp | nullable                                          |
| version                 | INTEGER   | NOT NULL DEFAULT 1                                |
| created_at / updated_at | timestamp | NOT NULL                                          |

Unique: `(project_id, resource_key)` — one lock per resource.
The `fence` column is monotonically increasing. Persistence layer rejects writes where the
fence held at acquisition is less than the current fence (stale-fence guard).

---

### idempotency_keys

| Column                  | Type       | Constraints               |
| ----------------------- | ---------- | ------------------------- |
| id                      | TEXT       | PRIMARY KEY               |
| key                     | TEXT       | NOT NULL                  |
| scope                   | TEXT       | NOT NULL DEFAULT 'global' |
| result                  | TEXT/JSONB | nullable (cached result)  |
| expires_at              | timestamp  | NOT NULL                  |
| version                 | INTEGER    | NOT NULL DEFAULT 1        |
| created_at / updated_at | timestamp  | NOT NULL                  |

`result` is NULL at creation and set once the idempotent operation completes, so `version` and
`updated_at` apply. Unique: `(key, scope)`. Index: `expires_at` (TTL sweep).

---

### outbox_events

| Column                  | Type       | Constraints                |
| ----------------------- | ---------- | -------------------------- |
| id                      | TEXT       | PRIMARY KEY                |
| event_type              | TEXT       | NOT NULL                   |
| payload                 | TEXT/JSONB | NOT NULL                   |
| payload_schema_version  | TEXT       | NOT NULL                   |
| status                  | TEXT       | NOT NULL DEFAULT 'pending' |
| attempts                | INTEGER    | NOT NULL DEFAULT 0         |
| last_attempted_at       | timestamp  | nullable                   |
| delivered_at            | timestamp  | nullable                   |
| error                   | TEXT       | nullable                   |
| version                 | INTEGER    | NOT NULL DEFAULT 1         |
| created_at / updated_at | timestamp  | NOT NULL                   |

Standalone — no FK (decoupled event delivery). Indexes: `status`, `created_at`.
Status values: `pending / delivered / failed`.
Draining: deterministic backoff polling, **not** WAL-tailing (portable across SQLite/PostgreSQL).
Payload carries **references and IDs, never secrets**.

---

### inbox_events

| Column                  | Type       | Constraints                                       |
| ----------------------- | ---------- | ------------------------------------------------- |
| id                      | TEXT       | PRIMARY KEY                                       |
| dedup_key               | TEXT       | NOT NULL UNIQUE (GitHub `X-GitHub-Delivery` GUID) |
| source                  | TEXT       | NOT NULL DEFAULT 'github'                         |
| event_type              | TEXT       | NOT NULL                                          |
| payload                 | TEXT/JSONB | NOT NULL                                          |
| payload_schema_version  | TEXT       | NOT NULL                                          |
| status                  | TEXT       | NOT NULL DEFAULT 'pending'                        |
| attempts                | INTEGER    | NOT NULL DEFAULT 0                                |
| last_attempted_at       | timestamp  | nullable                                          |
| processed_at            | timestamp  | nullable                                          |
| error                   | TEXT       | nullable                                          |
| version                 | INTEGER    | NOT NULL DEFAULT 1                                |
| created_at / updated_at | timestamp  | NOT NULL                                          |

Standalone. Unique: `dedup_key`. Index: `status`.
Status values: `pending / processed / failed / skipped`.

---

### human_approvals

| Column                  | Type      | Constraints                                                                                           |
| ----------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                                                                                           |
| project_id              | TEXT      | NOT NULL FK projects                                                                                  |
| feature_request_id      | TEXT      | nullable FK feature_requests                                                                          |
| feature_run_id          | TEXT      | nullable FK feature_runs                                                                              |
| context_type            | TEXT      | NOT NULL (plan_activation / budget_override / disagreement_resolution / merge_gate / design_document) |
| context_id              | TEXT      | nullable (ID of the entity being approved)                                                            |
| decision                | TEXT      | nullable (approved / rejected / deferred)                                                             |
| actor                   | TEXT      | NOT NULL                                                                                              |
| actor_role              | TEXT      | NOT NULL (approver / admin)                                                                           |
| notes                   | TEXT      | nullable                                                                                              |
| decided_at              | timestamp | nullable                                                                                              |
| version                 | INTEGER   | NOT NULL DEFAULT 1                                                                                    |
| created_at / updated_at | timestamp | NOT NULL                                                                                              |

Indexes: `project_id`, `feature_run_id`.

---

### policy_decisions

| Column                  | Type       | Constraints                                                                 |
| ----------------------- | ---------- | --------------------------------------------------------------------------- |
| id                      | TEXT       | PRIMARY KEY                                                                 |
| project_id              | TEXT       | NOT NULL FK projects                                                        |
| feature_run_id          | TEXT       | nullable FK feature_runs                                                    |
| policy_type             | TEXT       | NOT NULL (budget_soft_limit / budget_hard_limit / sequential_execution / …) |
| decision                | TEXT       | NOT NULL (paused / resumed / blocked / allowed)                             |
| context                 | TEXT/JSONB | nullable                                                                    |
| actor                   | TEXT       | nullable                                                                    |
| decided_at              | timestamp  | NOT NULL                                                                    |
| version                 | INTEGER    | NOT NULL DEFAULT 1                                                          |
| created_at / updated_at | timestamp  | NOT NULL                                                                    |

Indexes: `project_id`.

---

### agent_adapters

| Column                  | Type      | Constraints                                                                                                                                     |
| ----------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                                                                                                                                     |
| role                    | TEXT      | NOT NULL (PlannerAgentAdapter / CoderAgentAdapter / ReviewerAgentAdapter / ArbiterAgentAdapter / DocumentationAgentAdapter / HumanAgentAdapter) |
| name                    | TEXT      | NOT NULL                                                                                                                                        |
| implementation          | TEXT      | NOT NULL (class/module identifier)                                                                                                              |
| is_active               | BOOL/INT  | NOT NULL DEFAULT true                                                                                                                           |
| version                 | INTEGER   | NOT NULL DEFAULT 1                                                                                                                              |
| created_at / updated_at | timestamp | NOT NULL                                                                                                                                        |

---

### agent_capabilities

| Column                  | Type       | Constraints                |
| ----------------------- | ---------- | -------------------------- |
| id                      | TEXT       | PRIMARY KEY                |
| adapter_id              | TEXT       | NOT NULL FK agent_adapters |
| capability              | TEXT       | NOT NULL                   |
| parameters              | TEXT/JSONB | nullable                   |
| version                 | INTEGER    | NOT NULL DEFAULT 1         |
| created_at / updated_at | timestamp  | NOT NULL                   |

Indexes: `adapter_id`.

---

### agent_configurations

| Column                  | Type       | Constraints                |
| ----------------------- | ---------- | -------------------------- |
| id                      | TEXT       | PRIMARY KEY                |
| adapter_id              | TEXT       | NOT NULL FK agent_adapters |
| project_id              | TEXT       | nullable FK projects       |
| config                  | TEXT/JSONB | NOT NULL (no secrets)      |
| version                 | INTEGER    | NOT NULL DEFAULT 1         |
| created_at / updated_at | timestamp  | NOT NULL                   |

Indexes: `adapter_id`. Config never contains secrets; secrets resolve through the SecretBackend.

---

### agent_runs

| Column                  | Type         | Constraints                       |
| ----------------------- | ------------ | --------------------------------- |
| id                      | TEXT         | PRIMARY KEY                       |
| adapter_id              | TEXT         | NOT NULL FK agent_adapters        |
| project_id              | TEXT         | nullable FK projects              |
| feature_run_id          | TEXT         | nullable FK feature_runs          |
| role                    | TEXT         | NOT NULL                          |
| state                   | TEXT         | NOT NULL DEFAULT 'queued'         |
| input_summary           | TEXT         | nullable (sanitised — no secrets) |
| output_summary          | TEXT         | nullable                          |
| error                   | TEXT         | nullable                          |
| started_at / ended_at   | timestamp    | nullable                          |
| tokens_used             | INTEGER      | nullable                          |
| cost_usd                | REAL/NUMERIC | nullable                          |
| version                 | INTEGER      | NOT NULL DEFAULT 1                |
| created_at / updated_at | timestamp    | NOT NULL                          |

Indexes: `adapter_id`, `feature_run_id`, `state`.
State values: `queued / running / succeeded / failed / cancelled`.

---

### agent_errors

**Exception: immutable audit record — no `version`/`updated_at`.** Each row is a point-in-time
error observation and is never mutated.

| Column       | Type      | Constraints            |
| ------------ | --------- | ---------------------- |
| id           | TEXT      | PRIMARY KEY            |
| agent_run_id | TEXT      | NOT NULL FK agent_runs |
| error_type   | TEXT      | NOT NULL               |
| message      | TEXT      | NOT NULL               |
| stack        | TEXT      | nullable               |
| occurred_at  | timestamp | NOT NULL               |
| created_at   | timestamp | NOT NULL               |

Indexes: `agent_run_id`.

---

### agent_tool_operations

**Exception: immutable audit record — no `version`/`updated_at`.** Each row records a completed
tool invocation and is never mutated.

| Column         | Type      | Constraints                |
| -------------- | --------- | -------------------------- |
| id             | TEXT      | PRIMARY KEY                |
| agent_run_id   | TEXT      | NOT NULL FK agent_runs     |
| tool_name      | TEXT      | NOT NULL                   |
| input_summary  | TEXT      | nullable (sanitised)       |
| output_summary | TEXT      | nullable (sanitised)       |
| status         | TEXT      | NOT NULL (success / error) |
| duration_ms    | INTEGER   | nullable                   |
| occurred_at    | timestamp | NOT NULL                   |
| created_at     | timestamp | NOT NULL                   |

Indexes: `agent_run_id`.

---

### agent_context_packs

| Column                  | Type       | Constraints              |
| ----------------------- | ---------- | ------------------------ |
| id                      | TEXT       | PRIMARY KEY              |
| agent_run_id            | TEXT       | NOT NULL FK agent_runs   |
| content                 | TEXT/JSONB | NOT NULL (no secrets)    |
| content_schema_version  | TEXT       | NOT NULL DEFAULT '1.0.0' |
| version                 | INTEGER    | NOT NULL DEFAULT 1       |
| created_at / updated_at | timestamp  | NOT NULL                 |

Context packs are the only sanctioned source of task input to Workflow Layer tasks.

---

### adapter_conformance_results

**Exception: immutable test snapshot — no `version`/`updated_at`.** Each row is a completed
conformance test run result and is never mutated.

| Column       | Type       | Constraints                |
| ------------ | ---------- | -------------------------- |
| id           | TEXT       | PRIMARY KEY                |
| adapter_id   | TEXT       | nullable FK agent_adapters |
| role         | TEXT       | NOT NULL                   |
| test_suite   | TEXT       | NOT NULL                   |
| passed       | BOOL/INT   | NOT NULL DEFAULT false     |
| total_tests  | INTEGER    | NOT NULL DEFAULT 0         |
| failed_tests | INTEGER    | NOT NULL DEFAULT 0         |
| details      | TEXT/JSONB | nullable                   |
| run_at       | timestamp  | NOT NULL                   |
| created_at   | timestamp  | NOT NULL                   |

---

### review_findings

| Column                  | Type      | Constraints                                                                                  |
| ----------------------- | --------- | -------------------------------------------------------------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                                                                                  |
| feature_run_id          | TEXT      | NOT NULL FK feature_runs                                                                     |
| reviewer_run_id         | TEXT      | nullable FK agent_runs                                                                       |
| review_cycle            | INTEGER   | NOT NULL DEFAULT 1                                                                           |
| severity                | TEXT      | NOT NULL (blocking / non_blocking / question / nit / out_of_scope / requires_human_decision) |
| category                | TEXT      | nullable                                                                                     |
| description             | TEXT      | NOT NULL                                                                                     |
| file_path               | TEXT      | nullable                                                                                     |
| line_start / line_end   | INTEGER   | nullable                                                                                     |
| resolved                | BOOL/INT  | NOT NULL DEFAULT false                                                                       |
| resolved_by_run_id      | TEXT      | nullable FK agent_runs                                                                       |
| version                 | INTEGER   | NOT NULL DEFAULT 1                                                                           |
| created_at / updated_at | timestamp | NOT NULL                                                                                     |

Indexes: `feature_run_id`, `severity`.
`requires_human_decision` severity prevents merge and routes via `human_required` state.

---

### coder_responses

| Column                  | Type      | Constraints                                           |
| ----------------------- | --------- | ----------------------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                                           |
| finding_id              | TEXT      | NOT NULL FK review_findings                           |
| coder_run_id            | TEXT      | NOT NULL FK agent_runs                                |
| response_type           | TEXT      | NOT NULL (fixed / deferred / disputed / acknowledged) |
| notes                   | TEXT      | nullable                                              |
| version                 | INTEGER   | NOT NULL DEFAULT 1                                    |
| created_at / updated_at | timestamp | NOT NULL                                              |

Indexes: `finding_id`.

---

### disagreement_records

| Column                  | Type      | Constraints                                           |
| ----------------------- | --------- | ----------------------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                                           |
| feature_run_id          | TEXT      | NOT NULL FK feature_runs                              |
| finding_id              | TEXT      | nullable FK review_findings                           |
| review_cycle            | INTEGER   | NOT NULL                                              |
| state                   | TEXT      | NOT NULL DEFAULT 'open' (open / resolved / escalated) |
| arbiter_run_id          | TEXT      | nullable FK agent_runs                                |
| resolution              | TEXT      | nullable                                              |
| resolved_at             | timestamp | nullable                                              |
| version                 | INTEGER   | NOT NULL DEFAULT 1                                    |
| created_at / updated_at | timestamp | NOT NULL                                              |

Indexes: `feature_run_id`.

---

### budget_policies

| Column                  | Type         | Constraints                                       |
| ----------------------- | ------------ | ------------------------------------------------- |
| id                      | TEXT         | PRIMARY KEY                                       |
| project_id              | TEXT         | NOT NULL FK projects                              |
| scope                   | TEXT         | NOT NULL (project / feature / review_cycle)       |
| feature_request_id      | TEXT         | nullable FK feature_requests (feature-scope only) |
| currency                | TEXT         | NOT NULL DEFAULT 'USD'                            |
| soft_limit              | REAL/NUMERIC | nullable                                          |
| hard_limit              | REAL/NUMERIC | nullable                                          |
| window_days             | INTEGER      | nullable                                          |
| is_active               | BOOL/INT     | NOT NULL DEFAULT true                             |
| version                 | INTEGER      | NOT NULL DEFAULT 1                                |
| created_at / updated_at | timestamp    | NOT NULL                                          |

Indexes: `project_id`.
Hard limit breach → `paused_budget_exceeded`. Soft limit breach → `waiting_for_budget_approval`.

---

### cost_records

| Column                       | Type         | Constraints                                 |
| ---------------------------- | ------------ | ------------------------------------------- |
| id                           | TEXT         | PRIMARY KEY                                 |
| project_id                   | TEXT         | NOT NULL FK projects                        |
| feature_request_id           | TEXT         | nullable FK feature_requests                |
| feature_run_id               | TEXT         | nullable FK feature_runs                    |
| agent_run_id                 | TEXT         | nullable FK agent_runs                      |
| scope                        | TEXT         | NOT NULL (project / feature / review_cycle) |
| amount                       | REAL/NUMERIC | NOT NULL                                    |
| currency                     | TEXT         | NOT NULL DEFAULT 'USD'                      |
| provider                     | TEXT         | nullable                                    |
| model                        | TEXT         | nullable                                    |
| input_tokens / output_tokens | INTEGER      | nullable                                    |
| recorded_at                  | timestamp    | NOT NULL                                    |
| expires_at                   | timestamp    | nullable (TTL for sweep)                    |
| version                      | INTEGER      | NOT NULL DEFAULT 1                          |
| created_at / updated_at      | timestamp    | NOT NULL                                    |

Indexes: `project_id`, `expires_at`.

---

### artifact_exports

| Column                  | Type      | Constraints                                       |
| ----------------------- | --------- | ------------------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                                       |
| project_id              | TEXT      | NOT NULL FK projects                              |
| artifact_type           | TEXT      | NOT NULL (plan / backlog / final-design-document) |
| state                   | TEXT      | NOT NULL DEFAULT 'pending'                        |
| content                 | TEXT      | nullable                                          |
| format                  | TEXT      | NOT NULL DEFAULT 'markdown'                       |
| exported_at             | timestamp | nullable                                          |
| error                   | TEXT      | nullable                                          |
| version                 | INTEGER   | NOT NULL DEFAULT 1                                |
| created_at / updated_at | timestamp | NOT NULL                                          |

Indexes: `project_id`.
State values: `pending / generating / exported / stale / failed`.
Markdown artifacts are **never** runtime state — they are generated/importable snapshots only.

---

### design_documents

| Column                  | Type      | Constraints              |
| ----------------------- | --------- | ------------------------ |
| id                      | TEXT      | PRIMARY KEY              |
| project_id              | TEXT      | NOT NULL FK projects     |
| state                   | TEXT      | NOT NULL DEFAULT 'draft' |
| version                 | INTEGER   | NOT NULL DEFAULT 1       |
| created_at / updated_at | timestamp | NOT NULL                 |

Indexes: `project_id`.

---

### design_document_sections

| Column                  | Type      | Constraints                  |
| ----------------------- | --------- | ---------------------------- |
| id                      | TEXT      | PRIMARY KEY                  |
| design_document_id      | TEXT      | NOT NULL FK design_documents |
| section_name            | TEXT      | NOT NULL                     |
| content                 | TEXT      | nullable                     |
| order_index             | INTEGER   | NOT NULL DEFAULT 0           |
| version                 | INTEGER   | NOT NULL DEFAULT 1           |
| created_at / updated_at | timestamp | NOT NULL                     |

Unique: `(design_document_id, section_name)`.
The 13 required section names are defined in `06-implementation-plan.md` §Phase 17.

---

### design_decisions

| Column                  | Type      | Constraints                                                                 |
| ----------------------- | --------- | --------------------------------------------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                                                                 |
| project_id              | TEXT      | NOT NULL FK projects                                                        |
| design_document_id      | TEXT      | nullable FK design_documents                                                |
| title                   | TEXT      | NOT NULL                                                                    |
| context                 | TEXT      | nullable                                                                    |
| decision                | TEXT      | NOT NULL                                                                    |
| consequences            | TEXT      | nullable                                                                    |
| status                  | TEXT      | NOT NULL DEFAULT 'accepted' (proposed / accepted / deprecated / superseded) |
| version                 | INTEGER   | NOT NULL DEFAULT 1                                                          |
| created_at / updated_at | timestamp | NOT NULL                                                                    |

Indexes: `project_id`.

---

### glossary_terms

| Column                  | Type      | Constraints                               |
| ----------------------- | --------- | ----------------------------------------- |
| id                      | TEXT      | PRIMARY KEY                               |
| project_id              | TEXT      | nullable FK projects (null = global term) |
| term                    | TEXT      | NOT NULL                                  |
| definition              | TEXT      | NOT NULL                                  |
| category                | TEXT      | nullable                                  |
| version                 | INTEGER   | NOT NULL DEFAULT 1                        |
| created_at / updated_at | timestamp | NOT NULL                                  |

Unique: `(term, project_id)`.

---

### triggerdev_runs

| Column                   | Type      | Constraints                                                            |
| ------------------------ | --------- | ---------------------------------------------------------------------- |
| id                       | TEXT      | PRIMARY KEY                                                            |
| triggerdev_run_id        | TEXT      | NOT NULL UNIQUE                                                        |
| triggerdev_task_id       | TEXT      | NOT NULL (canonical task ID strings from §3.11 glossary)               |
| triggerdev_status        | TEXT      | NOT NULL (queued / running / waiting / succeeded / failed / cancelled) |
| project_id               | TEXT      | nullable FK projects                                                   |
| linked_workflow_event_id | TEXT      | nullable FK workflow_events                                            |
| linked_agent_run_id      | TEXT      | nullable FK agent_runs                                                 |
| linked_feature_run_id    | TEXT      | nullable FK feature_runs                                               |
| last_seen_at             | timestamp | NOT NULL                                                               |
| version                  | INTEGER   | NOT NULL DEFAULT 1                                                     |
| created_at / updated_at  | timestamp | NOT NULL                                                               |

Indexes: `triggerdev_task_id`, `project_id`.

---

### merge_gate_evaluations

| Column                       | Type      | Constraints                                       |
| ---------------------------- | --------- | ------------------------------------------------- |
| id                           | TEXT      | PRIMARY KEY                                       |
| feature_run_id               | TEXT      | NOT NULL FK feature_runs                          |
| ci_status                    | TEXT      | nullable (success / failure / pending)            |
| review_status                | TEXT      | nullable (approved / changes_requested / pending) |
| unresolved_blocking_findings | INTEGER   | NOT NULL DEFAULT 0                                |
| budget_status                | TEXT      | nullable (ok / soft_limit / hard_limit)           |
| human_approval_required      | BOOL/INT  | NOT NULL DEFAULT false                            |
| human_approval_id            | TEXT      | nullable FK human_approvals                       |
| branch_protection_ok         | BOOL/INT  | NOT NULL DEFAULT false                            |
| final_decision               | TEXT      | NOT NULL (approved / rejected)                    |
| evaluated_at                 | timestamp | NOT NULL                                          |
| version                      | INTEGER   | NOT NULL DEFAULT 1                                |
| created_at / updated_at      | timestamp | NOT NULL                                          |

Indexes: `feature_run_id`.
Every merge-gate run writes one evidence record. Unsafe PRs cannot be merged by MiniCoder.

---

## Dialect Notes

| Concern            | SQLite                                  | PostgreSQL           |
| ------------------ | --------------------------------------- | -------------------- |
| Timestamps         | TEXT (ISO-8601, UTC)                    | TIMESTAMPTZ          |
| Booleans           | INTEGER (0/1)                           | BOOLEAN              |
| JSON payload       | TEXT                                    | JSONB                |
| UUIDs              | TEXT (app-generated)                    | TEXT (app-generated) |
| Default timestamp  | `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` | `NOW()`              |
| FK enforcement     | `PRAGMA foreign_keys = ON` required     | Enforced by default  |
| Network filesystem | **Forbidden**                           | N/A (always TCP)     |

---

## Retention Policies

The spec requires every high-volume table to declare a retention policy. Policies are enforced by a
scheduled sweep task (deterministic polling, not WAL-tailing), which is portable across SQLite and
PostgreSQL.

| Table                   | Default retention                               | Sweep column                | Notes                                                                          |
| ----------------------- | ----------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| `workflow_events`       | 90 days                                         | `created_at`                | State-transition audit log; keep long enough for diagnostics                   |
| `inbox_events`          | 30 days after processing                        | `processed_at`              | Pending rows are never swept (processing not yet complete)                     |
| `outbox_events`         | 30 days after delivery                          | `delivered_at`              | Pending/failed rows are never swept (may need retry)                           |
| `idempotency_keys`      | Per `expires_at` (app-configured, default 24 h) | `expires_at`                | TTL set at insert time; sweep deletes rows where `expires_at < NOW()`          |
| `agent_runs`            | 90 days                                         | `created_at`                | Cascade-deletes `agent_errors`, `agent_tool_operations`, `agent_context_packs` |
| `agent_errors`          | With parent `agent_run`                         | —                           | ON DELETE CASCADE from `agent_runs`; no independent sweep needed               |
| `agent_tool_operations` | With parent `agent_run`                         | —                           | ON DELETE CASCADE from `agent_runs`; no independent sweep needed               |
| `cost_records`          | Per `expires_at` if set; otherwise 365 days     | `expires_at` / `created_at` | `expires_at` is nullable; rows without it fall back to the 365-day wall        |

**Sweep invariant:** the sweep task must never delete rows that are still actionable (pending
outbox/inbox events, unexpired idempotency keys, in-progress agent runs). The sweep predicate for
each table must check the appropriate status/state column in addition to the timestamp threshold.

**Configuration:** retention durations are configurable per deployment via `budget_policies`-style
config or environment variables; the values above are defaults, not hard-coded limits.

---

## Payload Hygiene Rules

- `outbox_events.payload` and `inbox_events.payload` carry **references and IDs, never secrets**.
- `agent_context_packs.content` carries sanitised context — no raw credentials, tokens, or keys.
- `agent_configurations.config` stores non-secret configuration; secrets resolve via `SecretBackend`.
- Private chain-of-thought is **never stored or exposed** (not in any column in this schema).
