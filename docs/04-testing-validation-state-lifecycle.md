# MiniCoder — Testing, Validation, and State Lifecycle Specification

> Status: Canonical
> Supersedes: minicoder_testing_validation_state_lifecycle_specification.md
> Version: 1.2.0
> Last-updated: 2026-06-13

The canonical CLI surface is defined once in [`00-glossary-and-terms.md`](00-glossary-and-terms.md)
§5; commands referenced here are a subset of that surface.

## 1. Purpose

This document defines the testing, validation, and state-lifecycle management requirements for
MiniCoder. MiniCoder is itself an automation system; therefore every workflow must be testable
without manual intervention. Humans approve real work, but tests must be fully automated.

## 2. Core Requirement

MiniCoder shall be fully testable in unattended mode across unit tests, integration tests, system
tests, Docker, Docker Compose, Kubernetes, CI, and staging.

All stateful subsystems must have lifecycle-management tools for development, CI, staging, and
production-safe maintenance. Stateful subsystems include the MiniCoder database; the Workflow
Layer's tasks, runs, queues, schedules, retries, and waitpoints (Trigger.dev); GitHub
webhook/event state; GitHub
PR/check/review simulation; agent-adapter run state; artifact exports/imports; cost records; human
approval records; and final design document records.

## 3. Testability Principles

### 3.1 No Human Required for Tests

No automated test scenario shall require a human to click a UI button, manually approve a workflow,
or manually manipulate external systems. Human actions are simulated through deterministic test
fixtures, API commands, mock adapters, or test-mode approvals.

### 3.2 Mock Providers by Default

Most tests must run without real Codex, real Claude, real paid LLM calls, real GitHub repository
mutation, real human approval, or real production Trigger.dev state.

### 3.3 Deterministic Scenarios

System tests must use deterministic fixtures so failures are reproducible.

### 3.4 Test Mode Is a First-Class Runtime Mode

MiniCoder provides a formal `system_test` mode:

```yaml
mode: system_test

agents:
  planner: mock-planner
  coder: mock-coder
  reviewer: mock-reviewer
  arbiter: mock-arbiter
  documentation: mock-documentation
  human: human-test # HumanTestAdapter — deterministic mock of HumanAgentAdapter (§4.2 glossary)

github:
  provider: mock

trigger:
  provider: triggerdev-test

database:
  reset_on_start: true
  seed_fixture: planning-review-merge
```

### 3.5 Production Safety

Destructive commands must be safe by default. Production reset/purge operations must be blocked or
require explicit, auditable, strongly guarded overrides.

## 4. Testing Levels

### 4.1 Unit Tests

Cover pure/domain logic: state-machine transitions, policy checks, feature selection, dependency
validation, planning-readiness scoring, clarification gap classification, review-finding
classification, merge-gate evaluation, budget-gate evaluation, idempotency behavior, disagreement
detection, and final-design-document eligibility. Unit tests must not require Docker, GitHub,
Trigger.dev, real agents, or network access.

### 4.2 Integration Tests

Cover subsystem boundaries: database repositories, migrations, command handlers, outbox/inbox
processing, Workflow Layer task wrappers, GitHub client against a mocked API, agent adapters with mock
providers, artifact import/export, API endpoints, cost manager, and the design document generator.
Integration tests run against **both** dialects — disposable SQLite databases **and** PostgreSQL
containers — as a matrix, not SQLite alone (see §8).

### 4.3 System Tests

Exercise end-to-end workflows with mock external systems.

Happy-path scenario:

```text
ingest specification
run readiness assessment
run clarification
generate plan
approve backlog
start feature
mock coder opens branch/PR
mock reviewer requests changes
mock coder fixes
mock reviewer approves
merge gate passes
feature merges
generate final design document
approve final design document
```

Additional scenarios:

```text
insufficient input → clarification questions
blocking gap unresolved → no backlog activation
review loop exceeded → human_required
budget exceeded → paused_budget_exceeded or waiting_for_budget_approval (glossary §3.8)
GitHub event race → workflow invalidated and reconciled
Trigger.dev task retry → idempotent completion
Trigger.dev waitpoint lost → reconciliation detects issue
database says running but Trigger.dev says failed → recovery path
```

### 4.4 Deployment Tests

Non-interactive validation for Docker, Docker Compose, and Kubernetes.

```text
deploy stack → run migrations → seed test project → execute system scenario
→ verify final state → export diagnostics → tear down
```

Kubernetes supports a Migration Job, Seed Job, System Test Job, Diagnostic Export Job, and
Reconciliation Job.

## 5. Required Lifecycle Tools

CLI tools for state-lifecycle management. The complete command surface lives in glossary §5. This
section specifies the behaviors each family must support.

### 5.1 Database Lifecycle

`minicoder db migrate | rollback | reset | seed | snapshot | restore | validate | diff | status`.

- SQLite local mode: create, migrate, reset, seed, snapshot, restore, validate.
- PostgreSQL hosted/team mode: migrate, safe rollback where supported, seed isolated test
  tenant/project, create isolated test schema/database, export diagnostics, restore from backup,
  validate migration status.

### 5.2 Trigger.dev Lifecycle

`minicoder trigger deploy | list-runs | inspect-run | cancel-run | replay-run | drain-queue |
reset-dev | validate | reconcile`.

Must handle stuck runs, failed runs, waiting runs, cancelled runs, duplicate runs, replayed runs,
orphaned waitpoints, queue backlog, and retry storms. Database correlation records track
`triggerdev_run_id`, `triggerdev_task_id`, `triggerdev_status`, `last_seen_at`,
`linked_workflow_event_id`, `linked_agent_run_id`, and `linked_feature_run_id` (table
`triggerdev_runs`, see [`01-system-specification.md`](01-system-specification.md) §8).

### 5.3 Workflow State Lifecycle

`minicoder state inspect | validate | reconcile | doctor | export-diagnostics | repair --dry-run`.

`doctor` detects database/Trigger.dev mismatch, database/GitHub mismatch, orphaned feature runs,
orphaned waitpoints, stale locks, stuck `human_required` states, failed outbox events, unprocessed
inbox events, stale artifact exports, and inconsistent cost records.

### 5.4 GitHub Simulation (test/dev only)

`minicoder github simulate-pr-opened | simulate-pr-synchronized | simulate-check-passed |
simulate-check-failed | simulate-review-approved | simulate-review-requested-changes |
simulate-pr-merged | simulate-pr-closed`.

### 5.5 Test Scenario Runner

`minicoder test unit | integration | system | scenario <name>`. The scenario runner returns
non-zero exit codes on failure for CI/CD use.

## 6. Mock Services and Adapters

Required mock adapters: `MockPlannerAdapter`, `MockCoderAdapter`, `MockReviewerAdapter`,
`MockArbiterAdapter`, `MockDocumentationAdapter`, `HumanTestAdapter`.

Required mock external systems: `MockGitHubProvider`, `MockTriggerRunner`, `MockCostProvider`,
`MockArtifactStorage`. **Canonical test seam:** `MockTriggerRunner` is the seam for unit and
integration tests; the real Trigger.dev test-harness wrapper is used **only** in the dedicated
Trigger.dev integration job. (Full unattended testability holds only because domain logic lives in
Orchestrator Core and task wrappers stay logic-free — enforced by the Phase 2 architectural fitness
tests; see `06-implementation-plan.md` Phase 2.)

Mock scenarios: planner returns sufficient / insufficient / sufficient_with_assumptions; coder
succeeds / fails / produces invalid output; reviewer approves / requests changes / repeats the same
finding; arbiter resolves / escalates; documentation generator succeeds / requires revision.

## 7. Production Safety Requirements

Destructive commands (`minicoder db reset`, `minicoder trigger reset-dev`, `minicoder state repair`)
must require an environment check, role/permission check, dry-run where possible, backup check where
applicable, explicit confirmation flag, and an audit event. Production reset is normally disallowed.
There is no unguarded bulk `purge`; irreversible maintenance is performed only through these guarded
workflows.

**Phase 1 implementation of `minicoder db reset`:**

| Requirement                   | Phase 1 status                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Explicit `--env` flag         | ✓ required; must be `development`, `test`, or `ci`                                       |
| Explicit `--yes` confirmation | ✓ required                                                                               |
| System env cross-check        | ✓ `APP_ENV`/`NODE_ENV` checked; non-safe system value blocks reset even with `--env dev` |
| Credential safety             | ✓ PostgreSQL URL logged with credentials stripped                                        |
| Dry-run / pre-run summary     | ✓ table list printed before any mutation                                                 |
| Audit event                   | ✓ timestamped block (env flag, system env, dialect, sanitized db, table count)           |
| Backup check                  | ⚠ operator warned; no automated backup                                                   |
| Permission / role check       | ⚠ noted in audit log; enforced from Phase 2                                              |
| Scope restriction             | ✓ only owned tables dropped, no `CASCADE`                                                |

```bash
minicoder db reset --yes --env development
```

## 8. CI/CD Requirements

GitHub Actions runs lint, typecheck, unit tests, integration tests, migration validation, a system
test smoke scenario, a **security scan** (dependency audit, secret scan, SAST — see
[`00-glossary-and-terms.md`](00-glossary-and-terms.md) §7), Docker build, Docker Compose test (where
applicable), and Trigger.dev task deployment validation. Longer system tests may run nightly or on
release branches.

**Cross-dialect matrix (required).** Migration validation and the integration suite run against
**both** database targets — SQLite and PostgreSQL — as parallel CI jobs, so dialect differences in
JSON querying, constraint behavior, and locking/transaction semantics are caught before release.

## 9. Kubernetes Requirements

Non-interactive testing via Jobs: migration job, seed job, system-test job, diagnostic-export job,
reconciliation job. Each job must be runnable unattended, emit structured logs, exit non-zero on
failure, and produce diagnostics when configured.

## 10. Acceptance Criteria

Satisfied when unit tests run without external services; integration tests run with disposable
databases and mocked providers; system tests run without real LLM calls or manual approval; Docker
Compose and Kubernetes system tests run non-interactively; database, Trigger.dev, and state
lifecycle/doctor commands exist; GitHub simulation commands exist; production-destructive operations
are guarded; and CI can execute meaningful MiniCoder workflows automatically.

---

## 11. Operations and Runbooks

MiniCoder must ship operational runbooks (not only test harnesses). Each runbook is a documented,
rehearsable procedure backed by the lifecycle CLI (§5) and validated by a test scenario where
possible.

Required runbooks:

- **Backup and restore** — database snapshot/restore (`db snapshot`/`db restore`); PostgreSQL
  backup and point-in-time restore; restore drills.
- **Database migrations** — forward migrate and safe rollback (`db migrate`/`db rollback`),
  including the dual SQLite/PostgreSQL paths and migration-status validation. Includes a
  **destructive column-change recipe**: SQLite's create-new-table → copy → drop → rename rebuild
  pattern (SQLite has limited `ALTER`), with the PostgreSQL equivalent. **Dialect-specific DDL is
  forbidden outside an approved migration helper**, keeping one migration set valid on both targets.
- **Local footprint** — `infra/docker-compose.triggerdev.yml` ships a **UI-only** development
  stack (Postgres + Redis + webapp, v3 images). It has no worker/supervisor, so tasks will queue
  but never execute; use it to browse the webapp and inspect DB state only. Even this "local SQLite"
  install therefore requires two additional Docker services (Trigger.dev's Postgres and Redis). Full
  v4 self-hosting (with task execution) requires additional services (supervisor, Docker socket
  proxy, task registry, object storage) — follow the official guide at
  `https://github.com/triggerdotdev/trigger.dev/tree/main/hosting/docker` before adding a worker or
  deploying to production. The default outbox drainer is a Trigger.dev scheduled task, so outbox
  liveness inherits the single-node SPOF; the **persistent background-worker** drainer alternative
  (`01-system-specification.md` §6) decouples outbox liveness from the scheduler.
- **Trigger.dev (self-host) operations** — resource sizing for the shipped v3 development stack:

  | Service  | CPU | RAM    |
  | -------- | --- | ------ |
  | postgres | 2   | 1 GB   |
  | redis    | 1   | 512 MB |
  | webapp   | 2   | 2 GB   |

  Procedures: version upgrades (update image tag in compose file, `docker compose pull && up -d`);
  backup Postgres (`pg_dump`) and Redis (AOF copy) with restore drills.

- **Stuck-workflow recovery** — detect via `state doctor`; reconcile (`state reconcile`);
  cancel/replay orphaned runs; clear stale locks/leases and orphaned waitpoints.
- **GitHub webhook replay** — reprocess missed or failed inbox events; fall back to scheduled
  reconciliation; verify dedup keys prevent double-processing.
- **Secret rotation** — rotate GitHub App/PAT, provider tokens, and webhook signing secrets with
  zero stored plaintext; see `07-security-and-secrets.md`.
- **Disaster recovery** — full rebuild from backups + reconciliation against GitHub truth, with a
  documented RPO/RTO target.

Each runbook must state preconditions, the exact guarded commands, expected diagnostics output, and
a rollback/abort path.

### Phase 1 — Database Lifecycle Runbook

This runbook covers the `minicoder db` commands shipped in Phase 1. Commands are executed via
`tsx packages/migrations/src/runner.ts <subcommand>` directly, or through the CLI
(`minicoder db <subcommand>`) once the CLI package is linked.

**Environment variables:**

| Variable     | SQLite example   | PostgreSQL example                        |
| ------------ | ---------------- | ----------------------------------------- |
| `DB_DIALECT` | `sqlite`         | `postgres`                                |
| `DB_PATH`    | `./minicoder.db` | _(not used)_                              |
| `DB_URL`     | _(not used)_     | `postgresql://user:pass@host:5432/dbname` |

#### Procedure: Forward migrate

Preconditions: database file/server is reachable; no other writer is mid-migration.

```bash
# SQLite
DB_DIALECT=sqlite DB_PATH=./minicoder.db \
  tsx packages/migrations/src/runner.ts migrate

# PostgreSQL
DB_DIALECT=postgres DB_URL=postgresql://user:pass@host:5432/dbname \
  tsx packages/migrations/src/runner.ts migrate
```

Expected output: `✓ Applied: 0001_initial_schema` (or "No pending migrations" if already up to date).

Rollback/abort: if the migration fails mid-run, the transaction rolls back atomically. Run
`status` to confirm state. Re-run `migrate` after fixing the root cause.

#### Procedure: Validate schema

Confirms all 43 expected tables are present. Run after every migration and in CI.

```bash
DB_DIALECT=sqlite DB_PATH=./minicoder.db \
  tsx packages/migrations/src/runner.ts validate
```

Expected output: `Validation PASSED. All 43 tables present.`
Exits non-zero if any table is missing; safe to run at any time.

#### Procedure: Migration status

```bash
DB_DIALECT=sqlite DB_PATH=./minicoder.db \
  tsx packages/migrations/src/runner.ts status
```

Expected output: one line per migration marked `✓ applied` or `○ pending`.

#### Procedure: Rollback last migration

Preconditions: a `*.down.sql` file exists for the last applied migration.
Only roll back on a quiesced system (no active runs).

```bash
DB_DIALECT=sqlite DB_PATH=./minicoder.db \
  tsx packages/migrations/src/runner.ts rollback
```

Expected output: `Rolled back: 0001_initial_schema`.
Drops all 43 tables; run `migrate` to re-apply.

#### Procedure: Destructive reset (dev/CI only)

Drops all MiniCoder-owned tables and re-applies all migrations from scratch. Only owned tables
are dropped (never foreign tables); drops proceed in reverse FK-dependency order without
`CASCADE` so external FK constraints are never silently removed.

**Safety contract** — the runner enforces all of the following before any mutation:

| Check                  | Enforcement                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--yes` confirmation   | Required                                                                                                                   |
| Explicit `--env` flag  | Required; value must be `development`, `test`, or `ci`                                                                     |
| System env cross-check | `APP_ENV`/`NODE_ENV` checked independently; a non-safe system value blocks reset even when `--env development` is supplied |
| Credential safety      | PostgreSQL connection URL logged with credentials stripped (host/database only)                                            |
| Audit event            | Printed to stdout before mutation: timestamp, env flag, system env, dialect, sanitized database identifier, table count    |
| Dry-run summary        | Tables to be dropped listed before execution                                                                               |
| Backup warning         | Operator warned that no backup has been verified                                                                           |
| Permission check       | Phase 1: noted in audit log; enforced by role system in Phase 2+                                                           |

**Never run against production.** PostgreSQL: use a dedicated development/CI database or a
separate schema. SQLite: use a throw-away file (`/tmp/dev.db`).

```bash
# SQLite
DB_DIALECT=sqlite DB_PATH=./dev.db \
  tsx packages/migrations/src/runner.ts reset --yes --env development

# PostgreSQL
DB_DIALECT=postgres DB_URL=postgresql://user:pass@host:5432/devdb \
  tsx packages/migrations/src/runner.ts reset --yes --env development

# CI (APP_ENV is advisory; --env flag is required regardless)
DB_DIALECT=sqlite DB_PATH=/tmp/ci.db \
  tsx packages/migrations/src/runner.ts reset --yes --env ci
```

Expected output: audit block, table list, "Dropped N owned tables", then migration output.

#### Procedure: Demo scenario

Verifies the full Phase 1 stack end-to-end on a fresh database.

```bash
DB_DIALECT=sqlite DB_PATH=/tmp/minicoder-demo.db \
  tsx packages/migrations/src/demo.ts
```

Expected output: all steps print `✓`; exits 0.

#### Diagnostics and known failure modes

| Symptom                                      | Likely cause                              | Resolution                                                                |
| -------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| `SQLITE_CANTOPEN`                            | `DB_PATH` directory does not exist        | Create the directory                                                      |
| `connect ECONNREFUSED`                       | PostgreSQL not running                    | Start Postgres or check `DB_URL`                                          |
| `Validation FAILED. Missing tables:`         | Migration not applied or partially failed | Run `migrate`, check for errors                                           |
| `Down migration not found`                   | `*.down.sql` file missing                 | Check `packages/migrations/migrations/` for the file                      |
| `UNIQUE constraint failed: _migrations.name` | Concurrent migration run                  | Serialise migration runs; only one process should run `migrate` at a time |

---

### Phase 3 — Trigger.dev (Self-Host) Operations Runbook

This runbook covers the `minicoder trigger` commands and the self-hosted single-node Trigger.dev
stack delivered in Phase 3. The stack definition is `infra/docker-compose.triggerdev.yml`.

#### Resource sizing

The shipped `infra/docker-compose.triggerdev.yml` is a **UI-only development stack** — it runs the
webapp and its dependencies but has no worker, so tasks will queue and never execute. For task
execution, follow the official self-hosting guide to add a worker/supervisor:
`https://github.com/triggerdotdev/trigger.dev/tree/main/hosting/docker`

| Service             | CPU | RAM    | Storage               |
| ------------------- | --- | ------ | --------------------- |
| triggerdev-webapp   | 2.0 | 2 GB   | —                     |
| triggerdev-postgres | 2.0 | 1 GB   | persistent volume     |
| triggerdev-redis    | 1.0 | 512 MB | AOF persistent volume |

A worker service is not included in the shipped stack (see compose file header). Resource sizing for
a worker follows the official Trigger.dev self-hosting guide.

#### Required environment variables

| Variable                    | Description                                 |
| --------------------------- | ------------------------------------------- |
| `TRIGGER_MAGIC_LINK_SECRET` | Random secret for magic-link auth           |
| `TRIGGER_SESSION_SECRET`    | Random secret for session cookies           |
| `TRIGGER_ENCRYPTION_KEY`    | 32-byte hex key for payload encryption      |
| `TRIGGERDEV_API_KEY`        | Project API key (created in the webapp)     |
| `TRIGGERDEV_API_URL`        | Self-host URL, e.g. `http://localhost:3040` |
| `TRIGGERDEV_WEBHOOK_SECRET` | Webhook signing secret — rotate per §7 docs |

#### Procedure: Start the self-hosted stack

Preconditions: Docker and Docker Compose are installed; env vars are set.

```bash
docker compose -f infra/docker-compose.triggerdev.yml up -d

# Wait for health checks
docker compose -f infra/docker-compose.triggerdev.yml ps
```

Expected: all services `Up (healthy)` or `Up`. Open `http://localhost:3040` for the webapp.

> **CLI command status (Phase 3):**
>
> - `minicoder trigger validate` — functional; reads `ALL_TASK_IDS` from the package.
> - All other `minicoder trigger` commands — exit 1 ("not implemented") until Phase 13 wires the
>   API layer. `list-runs` and `inspect-run` return static placeholder JSON only, not live data.
> - `minicoder state` commands (`doctor`, `reconcile`, etc.) — stub implementations pending Phase 4.

#### Procedure: Deploy tasks

```bash
pnpm --filter @minicoder/triggerdev build
minicoder trigger validate        # confirm all 9 task IDs present

# Direct CLI (until Phase 13 wires minicoder trigger deploy):
# TRIGGER_API_URL must always be set explicitly — omitting it causes the CLI to
# default to https://api.trigger.dev (Trigger.dev Cloud) regardless of backend config.
cd packages/triggerdev && \
  TRIGGER_PROJECT_REF=<your-ref> \
  npx trigger.dev@latest deploy --env staging --api-url "$TRIGGERDEV_API_URL"
```

Or via CI: the `.github/workflows/trigger-deploy.yml` workflow runs on push to the development
branch and deploys to `staging` by default; `prod` requires a manual workflow dispatch.

#### Procedure: Queue drain (CI / pre-deploy)

All `minicoder trigger` queue commands exit 1 until Phase 13. Monitor queue state via the
Trigger.dev webapp at `http://localhost:3040`. Wait for all runs to reach a terminal state before
running destructive operations or schema migrations.

#### Procedure: Inspect and replay a failed run

Use the Trigger.dev webapp at `http://localhost:3040` to view run history, inspect payloads, and
trigger replays. There is no supported CLI sub-command for replay in the current Trigger.dev v4
CLI; the webapp is the authoritative interface until Phase 13 provides `minicoder trigger
replay-run`.

#### Procedure: Cancel a stuck run

Use the Trigger.dev webapp at `http://localhost:3040` to cancel individual runs. There is no
supported `cancel` CLI sub-command in the current Trigger.dev v4 CLI. `minicoder trigger
cancel-run` is pending Phase 13.

#### Procedure: Reconcile DB vs live runs

`minicoder trigger reconcile` is pending Phase 13. Until then, manually compare `triggerdev_runs`
rows with status `running` against the Trigger.dev webapp run list and update stale rows directly
in the database. `minicoder state reconcile` (pending Phase 4) will automate the workflow-state
side of this reconciliation.

#### Procedure: Dev reset (dev/CI only)

> `minicoder trigger reset-dev` is not yet implemented (Phase 13). In the interim, use Docker
> Compose to restart the stack with a fresh database:

```bash
docker compose -f infra/docker-compose.triggerdev.yml down -v
docker compose -f infra/docker-compose.triggerdev.yml up -d
```

**Never run against staging or production.**

#### Procedure: Version upgrade of the self-hosted stack

1. Check for active runs: inspect the Trigger.dev webapp run list at http://localhost:3040
   (`minicoder trigger list-runs` returns placeholder JSON only; use the webapp for live status)
2. Wait for all runs to complete (monitor via Trigger.dev webapp)
3. Update the image tag in `infra/docker-compose.triggerdev.yml`
4. `docker compose -f infra/docker-compose.triggerdev.yml pull`
5. `docker compose -f infra/docker-compose.triggerdev.yml up -d`
6. `minicoder trigger validate` — confirm tasks still report correctly
7. Monitor `docker compose logs -f triggerdev-webapp` for errors

#### Procedure: Backup and restore Trigger.dev Postgres

```bash
# Backup
docker compose -f infra/docker-compose.triggerdev.yml exec triggerdev-postgres \
  pg_dump -U trigger trigger > /tmp/triggerdev-$(date +%Y%m%d).sql

# Restore (stop webapp first)
docker compose -f infra/docker-compose.triggerdev.yml stop triggerdev-webapp
docker compose -f infra/docker-compose.triggerdev.yml exec -T triggerdev-postgres \
  psql -U trigger trigger < /tmp/triggerdev-backup.sql
docker compose -f infra/docker-compose.triggerdev.yml start triggerdev-webapp
```

Redis AOF is persisted via Docker volume (`triggerdev-redis-data`). Back up by snapshotting the
volume or copying the AOF file.

#### Procedure: Webhook-secret rotation

See `docs/07-security-and-secrets.md` for the full procedure. In brief:

1. Generate a new secret: `openssl rand -hex 32`
2. Set `TRIGGERDEV_WEBHOOK_SECRET` in the deployment environment
3. Restart `triggerdev-webapp` with the new value
4. Update `TRIGGERDEV_WEBHOOK_SECRET` in the MiniCoder config/secrets backend

Zero downtime rotation requires a brief overlap window where both old and new secrets are accepted;
see `07-security-and-secrets.md` for the overlap procedure.

#### Diagnostics and known failure modes

| Symptom                                 | Likely cause                        | Resolution                                                                              |
| --------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| Tasks not appearing after deploy        | Build or deploy step failed         | Run `minicoder trigger validate`; check CI logs                                         |
| Run stuck in `running`                  | Worker crashed mid-run              | Cancel via Trigger.dev webapp; re-enqueue from webapp (CLI cancel/replay pending Ph 13) |
| DB row status `running` but no live run | Orphaned row from crash             | Manually update the `triggerdev_runs` row; `minicoder trigger reconcile` pending Ph 13  |
| `TRIGGER_SECRET_KEY not set`            | Env var missing                     | Set `TRIGGERDEV_API_KEY` and call `applyTriggerEnv`                                     |
| Webhook signature mismatch              | `TRIGGERDEV_WEBHOOK_SECRET` rotated | Update secret in all services simultaneously                                            |
