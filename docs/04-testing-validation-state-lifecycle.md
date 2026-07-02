# MiniCoder — Testing, Validation, and State Lifecycle Specification

> Status: Canonical
> Supersedes: minicoder_testing_validation_state_lifecycle_specification.md
> Version: 1.3.2
> Last-updated: 2026-06-30

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

### 5.4 GitHub Simulation (test/dev only) and Webhook Receiver

`minicoder github simulate-pr-opened | simulate-pr-closed | simulate-pr-merged |
simulate-check-passed | simulate-check-failed | simulate-review-approved |
simulate-review-changes-requested | simulate-branch-protection-ok`.

`minicoder github serve` (Phase 7) starts the real GitHub webhook receiver
(`POST /webhooks/github`); unlike `simulate-*`, it is not environment-guarded — see
[`01-system-specification.md`](01-system-specification.md) §5.7 and the Phase 7 runbook in §11.

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
- **Local footprint** — `infra/docker-compose.triggerdev.yml` ships a full **8-service v4
  execution stack**: Postgres, Redis, Electric (sync), webapp, Docker registry, MinIO (object
  store), docker-socket-proxy, and supervisor (worker). Even a "local SQLite" install therefore
  runs 8 additional Docker services. The supervisor uses the Docker socket (via the proxy) to
  launch task containers, so the host Docker daemon must be running. ClickHouse (analytics) is
  omitted from the development stack (`RUN_REPLICATION_ENABLED=false`); add it for production
  following the official guide at
  `https://github.com/triggerdotdev/trigger.dev/tree/main/hosting/docker`. The default outbox
  drainer is a Trigger.dev scheduled task, so outbox liveness inherits the single-node SPOF; the
  **persistent background-worker** drainer alternative (`01-system-specification.md` §6) decouples
  outbox liveness from the scheduler.
- **Trigger.dev (self-host) operations** — `infra/docker-compose.triggerdev.yml` ships a full v4
  execution stack (9 services: init, Postgres, Redis, Electric, webapp, registry, MinIO,
  docker-socket-proxy, supervisor). See the Phase 3 runbook in §11 for the complete resource
  sizing table, required env vars, startup procedure, and upgrade/backup procedures.

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

Confirms all expected tables are present (48 as of Phase 7; the count grows as later phases add migrations — see `EXPECTED_TABLES` in `packages/migrations/src/index.ts` for the authoritative current count). Run after every migration and in CI.

```bash
DB_DIALECT=sqlite DB_PATH=./minicoder.db \
  tsx packages/migrations/src/runner.ts validate
```

Expected output: `Validation PASSED. All 48 tables present.` (Phase 7)
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
Drops the last-applied migration's tables; run `migrate` to re-apply.

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

`infra/docker-compose.triggerdev.yml` ships a 9-service full execution stack. ClickHouse
(analytics) is omitted from the development stack (`RUN_REPLICATION_ENABLED=false`).

| Service                 | CPU  | RAM    | Storage               |
| ----------------------- | ---- | ------ | --------------------- |
| triggerdev-init         | 0.1  | 32 MB  | shared volume (chown) |
| triggerdev-postgres     | 2.0  | 1 GB   | persistent volume     |
| triggerdev-redis        | 1.0  | 512 MB | AOF persistent volume |
| triggerdev-electric     | 0.5  | 256 MB | —                     |
| triggerdev-webapp       | 4.0  | 4 GB   | shared volume (token) |
| triggerdev-registry     | 0.5  | 256 MB | persistent volume     |
| triggerdev-minio        | 0.5  | 512 MB | persistent volume     |
| triggerdev-docker-proxy | 0.25 | 64 MB  | — (Docker socket ro)  |
| triggerdev-supervisor   | 2.0  | 2 GB   | shared volume (token) |

#### Required environment variables

Generate all secrets with `openssl rand -hex 32` unless noted otherwise.

| Variable                        | Description                                           |
| ------------------------------- | ----------------------------------------------------- |
| `TRIGGER_MAGIC_LINK_SECRET`     | Random secret for magic-link auth                     |
| `TRIGGER_SESSION_SECRET`        | Random secret for session cookies                     |
| `TRIGGER_ENCRYPTION_KEY`        | 32-byte hex key for payload encryption                |
| `TRIGGER_MANAGED_WORKER_SECRET` | Shared secret between webapp and supervisor           |
| `TRIGGERDEV_WEBHOOK_SECRET`     | Webhook signing secret — rotate per §7 docs           |
| `MINIO_ROOT_USER`               | MinIO access key (e.g. `minioadmin`)                  |
| `MINIO_ROOT_PASSWORD`           | MinIO secret — `openssl rand -hex 16`                 |
| `TRIGGERDEV_API_KEY`            | Project API key (created in the webapp after startup) |
| `TRIGGERDEV_API_URL`            | Self-host URL, e.g. `http://localhost:3040`           |

**Task container DB env vars** — Trigger.dev task containers are ephemeral Docker containers
spun up by the supervisor. They inherit the project environment set in the Trigger.dev dashboard
or CLI. Set these in the project environment so `createDbClientFromEnv()` can connect to a
migrated database (it performs a schema check on startup and rejects containers that point to
an unmigrated or missing DB):

| Variable     | Required for  | Description                                                   |
| ------------ | ------------- | ------------------------------------------------------------- |
| `DB_DIALECT` | always        | `sqlite` or `postgres`                                        |
| `DB_PATH`    | SQLite only   | Path to migrated SQLite file (must be mounted into container) |
| `DB_URL`     | Postgres only | PostgreSQL connection string to a migrated database           |

#### Procedure: Start the self-hosted stack

Preconditions: Docker and Docker Compose are installed; all env vars are set;
`/var/run/docker.sock` is accessible (required by `triggerdev-docker-proxy`).

```bash
docker compose -f infra/docker-compose.triggerdev.yml up -d

# Wait for all services to become healthy (webapp + supervisor take ~60s to bootstrap)
# triggerdev-init exits immediately (service_completed_successfully); the remaining 8 run continuously.
docker compose -f infra/docker-compose.triggerdev.yml ps
```

Expected: `triggerdev-init` shows `Exited (0)`; all 8 remaining services `Up (healthy)` or `Up`. The webapp auto-bootstraps on first start,
creates a default worker group, and writes the worker token to the shared volume. The supervisor
reads this token and connects. Open `http://localhost:3040` to verify the webapp and confirm
the worker appears in the Workers section.

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
  npx trigger.dev@4.4.6 deploy --env staging --api-url "$TRIGGERDEV_API_URL"
```

Or via CI: the `.github/workflows/trigger-deploy.yml` workflow runs on push to the development
branch and deploys to `staging` by default; `prod` requires a manual workflow dispatch.

> **CI registry constraint:** The deploy-tasks job pushes task images to `DEPLOY_REGISTRY_HOST`
> (default `localhost:5000`). GitHub-hosted runners resolve `localhost` to themselves, not to
> the self-hosted Trigger.dev stack. For CI deployments either: (a) use a self-hosted runner
> co-located with the stack, or (b) set `DEPLOY_REGISTRY_HOST` to an externally-reachable
> registry URL in the environment's variable settings.

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

| Symptom                                 | Likely cause                        | Resolution                                                                             |
| --------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| Tasks not appearing after deploy        | Build or deploy step failed         | Run `minicoder trigger validate`; check CI logs                                        |
| Run stuck in `running`                  | Supervisor crashed mid-run          | Cancel via Trigger.dev webapp; check `docker compose logs triggerdev-supervisor`       |
| DB row status `running` but no live run | Orphaned row from crash             | Manually update the `triggerdev_runs` row; `minicoder trigger reconcile` pending Ph 13 |
| `TRIGGER_SECRET_KEY not set`            | Env var missing                     | Set `TRIGGERDEV_API_KEY` and call `applyTriggerEnv`                                    |
| Webhook signature mismatch              | `TRIGGERDEV_WEBHOOK_SECRET` rotated | Update secret in all services simultaneously                                           |

---

### Phase 7 — GitHub Integration and Reconciliation Runbook

This runbook covers the GitHub App/webhook setup, the standalone webhook receiver
(`minicoder github serve`), webhook-secret rotation, and reconciliation diagnostics delivered in
Phase 7 (`packages/github`, `packages/core/src/github/`, migration `0009_pull_requests`). This is
distinct from the Trigger.dev webhook-secret rotation runbook above (§Phase 3) — the two secrets
protect different webhook endpoints and rotate independently.

#### GitHub App setup

1. Create a GitHub App (Settings → Developer settings → GitHub Apps → New GitHub App).
2. Required repository permissions: **Contents** (read/write), **Pull requests** (read/write),
   **Checks** (read/write), **Commit statuses** (read/write), **Metadata** (read).
3. Subscribe to webhook events: `Pull request`, `Pull request review`,
   `Pull request review comment`, `Check suite`, `Check run`, `Status`, `Push`.
4. Set the webhook URL to the deployed `minicoder github serve` endpoint:
   `https://<host>/webhooks/github`.
5. Generate a webhook secret (`openssl rand -hex 32`) and set it as the GitHub App's webhook
   secret **and** as `GITHUB_WEBHOOK_SECRET` in the MiniCoder deployment environment.
6. Install the App on the target repository/organization and record the installation ID.
7. Link the repository to a MiniCoder project: insert a `repositories` row
   (`owner`, `name`, `full_name`) — the webhook receiver resolves the internal `projectId` via
   `repositories.full_name`; webhooks for unlinked repositories are acknowledged (`202`) without
   being persisted.

For local/single-node development, a personal access token (`GITHUB_TOKEN`) with the same scopes
may be used instead of a GitHub App installation token (`OctokitGitHubClient` accepts either).

#### Required environment variables

| Variable                         | Description                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`          | Current webhook signing secret — required to start `minicoder github serve`       |
| `GITHUB_WEBHOOK_SECRET_PREVIOUS` | Previous secret, set only during a rotation overlap window                        |
| `GITHUB_TOKEN`                   | PAT or installation token used by `OctokitGitHubClient` / `github-reconciliation` |

#### Procedure: Start the webhook receiver

```bash
GITHUB_WEBHOOK_SECRET=<secret> \
DB_DIALECT=sqlite DB_PATH=./minicoder.db \
minicoder github serve --port 3100 --host 0.0.0.0
```

`minicoder github serve` is **not** gated by the dev/test/ci environment guard that
`minicoder github simulate-*` uses — it is the real webhook receiver and is expected to run in
production/hosted deployments. Phase 13's Fastify orchestrator API mounts the same
`registerGithubWebhookRoute()` handler instead of re-implementing it.

#### Procedure: Webhook-secret rotation

1. Generate a new secret: `openssl rand -hex 32`.
2. Set `GITHUB_WEBHOOK_SECRET_PREVIOUS` to the current (soon-to-be-old) value of
   `GITHUB_WEBHOOK_SECRET`.
3. Set `GITHUB_WEBHOOK_SECRET` to the newly generated secret.
4. Restart `minicoder github serve` (or the Phase 13 API process hosting the route) — during this
   window `verifyWebhookSignature()` accepts either secret.
5. Update the webhook secret on the GitHub App itself to match the new `GITHUB_WEBHOOK_SECRET`.
6. Once no more deliveries are observed signed with the old secret, unset
   `GITHUB_WEBHOOK_SECRET_PREVIOUS` and restart.

#### Procedure: Reconciliation diagnostics

- **Force a reconciliation pass** for a project: invoke the `github-reconciliation` Trigger.dev
  task with `{ projectId }` (omit `featureRunId` to sweep every active feature run in the
  project that already has a tracked `pull_requests` row).
- **Force a reconciliation pass** for a single feature run: invoke `github-reconciliation` with
  `{ projectId, featureRunId }`.
- **Inspect current GitHub-observed state** for a feature run:
  `SELECT * FROM pull_requests WHERE feature_run_id = '<id>'`.
- **Confirm no divergence**: `minicoder state doctor` / `minicoder state inspect` should show the
  feature run's `feature_runs.current_execution_state` consistent with `pull_requests.ci_status` /
  `pull_requests.review_state` for its current phase (e.g. `ci_running` ↔ `ci_status='running'`).
- A feature run stuck at `human_required` with a `pull_requests.state = 'closed'` and
  `merged_at IS NULL` indicates the irreconcilable-divergence escalation path fired (PR closed
  without merging while MiniCoder still expected it open) — this requires a human disposition,
  not a reconciliation retry.

#### Diagnostics and known failure modes

| Symptom                                                         | Likely cause                                         | Resolution                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `minicoder github serve` exits immediately                      | `GITHUB_WEBHOOK_SECRET` unset                        | Set `GITHUB_WEBHOOK_SECRET` before starting                               |
| Webhook returns `401`                                           | Signature mismatch (secret rotated or misconfigured) | Verify `GITHUB_WEBHOOK_SECRET` matches the GitHub App's configured secret |
| Webhook returns `202 unlinked-repository`                       | No `repositories` row for the delivering repo        | Insert a `repositories` row linking `full_name` to the MiniCoder project  |
| `github-reconciliation` throws "GITHUB_TOKEN is not configured" | No GitHub credential in the task environment         | Set `GITHUB_TOKEN` (or wire GitHub App installation-token retrieval)      |
| Feature run stuck, no `pull_requests` row                       | PR never opened/observed yet (still `code_pushed`)   | Not a bug — the scheduled fallback only reconciles PRs it already tracks  |

---

## 12. Phase 4 Runbook — Test Harness and State Lifecycle Tooling

This section documents the operational procedures added in Phase 4.

### 12.1 Seeding the Database

Insert a named fixture into the database (development/test/CI only):

```bash
# Insert the planning-review-merge fixture (default)
minicoder db seed --env development

# Insert a specific fixture
minicoder db seed --fixture clarification-required --env development

# Insert with a custom project ID
minicoder db seed --fixture backlog-activation --project my-proj --env development
```

Available fixture names:

- `planning-basic` — project, spec, assessment (sufficient), plan (draft)
- `planning-review-merge` — full happy-path: project, spec, plan (approved), 5 features at `approved_pending_execution`
- `clarification-required` — project, spec, assessment (insufficient), 2 unanswered questions
- `backlog-activation` — project, plan (approved), 3 features at `approved_pending_execution`
- `review-loop` — feature at `under_review`, 2 blocking findings
- `merge-gate` — feature at `merge_ready`, 1 approved MergeGateEvaluation
- `trigger-retry` — feature at `selected`, triggerdev_runs row at `failed`
- `github-race` — feature at `ci_running`, inbox_events row with `pr.closed`
- `final-design-document` — project (implementation_complete), artifact_exports (pending), design_documents row

### 12.2 Database Snapshot and Restore

Snapshot the SQLite database (SQLite only; use `pg_dump` for PostgreSQL):

```bash
# Take a snapshot
minicoder db snapshot --output ./backup-2026-06-29.db

# Restore from a snapshot (dev/CI only)
minicoder db restore --input ./backup-2026-06-29.db --yes --env development
```

A JSON sidecar file (`<output>.meta.json`) is written alongside the snapshot with metadata.

### 12.3 Migration Diff

List pending migrations not yet applied to the database:

```bash
minicoder db diff
```

Output includes applied migrations, pending migrations, and an `upToDate` flag.

### 12.4 GitHub Event Simulation

Simulate GitHub events to drive the inbox processor (development/test/CI only):

```bash
# Simulate PR opened
minicoder github simulate-pr-opened --project proj-1 --pr-number 42 --head-sha abc123

# Simulate CI check passed
minicoder github simulate-check-passed --project proj-1 --pr-number 42 --check-name ci/test

# Simulate CI check failed
minicoder github simulate-check-failed --project proj-1 --pr-number 42

# Simulate review approved
minicoder github simulate-review-approved --project proj-1 --pr-number 42 --reviewer alice

# Simulate review requesting changes
minicoder github simulate-review-changes-requested --project proj-1 --pr-number 42 --reviewer alice

# Simulate PR merged
minicoder github simulate-pr-merged --project proj-1 --pr-number 42 --merge-sha def456

# Simulate PR closed (without merge)
minicoder github simulate-pr-closed --project proj-1 --pr-number 42

# Simulate branch protection OK
minicoder github simulate-branch-protection-ok --project proj-1 --pr-number 42
```

Each command inserts a row into `inbox_events` and prints a JSON confirmation.

### 12.5 Running System Scenarios

Run all system scenarios against an in-memory SQLite database:

```bash
DB_DIALECT=sqlite DB_PATH=:memory: APP_ENV=ci minicoder test system
```

Run a single named scenario:

```bash
DB_DIALECT=sqlite DB_PATH=:memory: APP_ENV=ci minicoder test scenario planning-basic
DB_DIALECT=sqlite DB_PATH=:memory: APP_ENV=ci minicoder test scenario clarification-required
```

Available scenario names mirror the fixture names. All 8 scenarios are registered in `SCENARIO_REGISTRY`.

### 12.6 State Doctor

Detect anomalies in workflow state:

```bash
# Check all projects
minicoder state doctor

# Check a specific project
minicoder state doctor --project proj-1
```

The doctor runs 5 checks:

| Check                 | Severity | Auto-clearable      |
| --------------------- | -------- | ------------------- |
| `stale_locks`         | error    | yes                 |
| `stuck_outbox`        | error    | yes                 |
| `stuck_inbox`         | error    | yes                 |
| `orphaned_runs`       | error    | manually repairable |
| `triggerdev_mismatch` | warning  | no (Phase 13)       |

Exits with code 1 if any error-severity issues are found.

#### Interpreting Output

```json
{
  "command": "state doctor",
  "healthy": false,
  "checks": [
    { "name": "stale_locks", "severity": "error", "autoClearable": true, "count": 2 },
    { "name": "stuck_outbox", "severity": "ok", "count": 0 }
  ]
}
```

### 12.7 State Reconcile

Clear auto-clearable anomalies found by the doctor:

```bash
# Reconcile all auto-clearable issues
minicoder state reconcile --all

# Reconcile for a specific project
minicoder state reconcile --project proj-1
```

Auto-cleared issues:

- **stale_locks** — sets `expires_at = now`
- **stuck_outbox** — marks status `failed`
- **stuck_inbox** — marks status `failed`

Orphaned runs require `state repair --apply` (manually repairable path).

### 12.8 Export Diagnostics

Export full state diagnostics to a file or stdout:

```bash
# Export to stdout
minicoder state export-diagnostics --project proj-1

# Export to file
minicoder state export-diagnostics --project proj-1 --output /tmp/diagnostics.json
```

The export includes: project row, last 50 workflow events, pending outbox/inbox events,
running/failed triggerdev_runs, and all workflow locks.

### 12.9 State Repair

The repair workflow is two-step to prevent accidental execution:

```bash
# Step 1: Dry-run — preview repairs and get a single-use token
minicoder state repair --dry-run --project proj-1

# Step 2: Apply — provide the token issued in step 1
minicoder state repair --apply --confirmation <token> --project proj-1
```

The confirmation token is time-boxed (5 minutes) and single-use. The token file is stored at
`~/.minicoder/pending-repair-token.json` and consumed when `--apply` succeeds.

Currently repairable: orphaned runs are marked `human_required`. A `workflow_events` row with
`event_type = 'state.repaired'` is written on success.

### 12.10 Docker Compose Test Flow

Run the full test suite against PostgreSQL in Docker Compose:

```bash
docker compose -f infra/docker-compose.test.yml up \
  --exit-code-from minicoder-test \
  --abort-on-container-exit
```

This spins up Postgres 16 with a health check, then runs install → build → migrate → validate
→ vitest → system scenario smoke tests. Exits with the test container's exit code.

### 12.11 Kubernetes Job Execution

Apply the K8s job manifests:

```bash
# Run migrations
kubectl apply -f infra/k8s/migration-job.yaml
kubectl wait --for=condition=complete job/minicoder-migration --timeout=120s

# Seed data (CI only)
kubectl apply -f infra/k8s/seed-job.yaml
kubectl wait --for=condition=complete job/minicoder-seed --timeout=60s

# Run system tests
kubectl apply -f infra/k8s/system-test-job.yaml
kubectl wait --for=condition=complete job/minicoder-system-test --timeout=300s

# Export diagnostics
kubectl apply -f infra/k8s/diagnostic-export-job.yaml

# Install reconciliation CronJob (runs every 30 minutes)
kubectl apply -f infra/k8s/reconciliation-job.yaml
```

All jobs except the CronJob require a `minicoder-db-secret` Secret with `dialect` and `url` keys.

### 12.12 Diagnostics and Known Failure Modes (Phase 4)

| Symptom                                                | Likely cause                                       | Resolution                                                            |
| ------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------- |
| `db seed` fails with "Unknown fixture"                 | Fixture name typo                                  | Run `minicoder db seed --fixture ?` to see valid names                |
| `db seed` fails with PostgreSQL dialect error          | Fixtures are SQLite-only                           | Use `pg_restore` to load test data for PostgreSQL environments        |
| `db snapshot` fails with "already exists"              | Output file collision                              | Delete existing file or choose a different output path                |
| `db restore` rejected in production                    | `NODE_ENV` or `APP_ENV=production`                 | Set env to `development`, `test`, or `ci` and use `--env`             |
| `state doctor` exits 1                                 | Error-severity anomalies found                     | Run `minicoder state reconcile --all` for auto-clearable issues       |
| `state validate` exits 1                               | Feature run has unknown state                      | Validates enum membership; does not check transition history          |
| `state repair --apply` fails with token mismatch       | Token file tampered or expired                     | Re-run `--dry-run` to get a new token                                 |
| `state repair` exits 1 with "project required"         | `--project` flag omitted                           | Provide `--project <id>`; global repair is not supported              |
| `test scenario` exits 1                                | Scenario assertion failed                          | Check the `error` field in JSON output                                |
| `github simulate-*` fails with env guard               | Wrong `APP_ENV`                                    | Set `APP_ENV=development` or `APP_ENV=ci`                             |
| `github simulate-*` fails on PostgreSQL                | SQLite-only timestamps                             | These commands use JS ISO timestamps and support both dialects        |
| `pnpm audit --audit-level=high` exits non-zero locally | Known dev-only vitest/vite advisories (see §12.13) | Expected; CI enforces `--prod` gate only — runtime deps are clean     |
| `state reconcile` exits 1 with no flags                | Neither `--project` nor `--all` supplied           | Pass `--project <id>` for scoped or `--all` for global queue clearing |

#### `db seed` — SQLite-only scope

`minicoder db seed` uses SQLite-specific SQL (`INSERT OR IGNORE`, `datetime('now')`). It exits 1
with a clear error if `DB_DIALECT=postgres`. For PostgreSQL environments, use `pg_restore` or a
purpose-built seed script that uses standard SQL.

#### `state validate` — enum membership check only

`state validate` checks that every active feature run's `current_execution_state` is a member of
the known enum (`KNOWN_FEATURE_STATES`). It does **not** verify transition history or enforce that
the state was reached via a valid path. Use `state inspect` and the workflow event log for
transition-history analysis.

#### `state repair --apply` — transactional guarantee

The `repair --apply` path wraps all mutations and the `workflow_events` audit INSERT in a single
database transaction. The confirmation token file is deleted **only after** the transaction commits
successfully. If the transaction fails, the token is preserved and the command can be retried.

#### §12.13 Known dev-only audit advisories — accepted risk

Two known advisories affect the dev toolchain but are not exploitable in this project:

| Advisory                       | Package  | Patched at | Why not exploitable here                                                         |
| ------------------------------ | -------- | ---------- | -------------------------------------------------------------------------------- |
| GHSA-5xrq-8626-4rwp (critical) | `vitest` | ≥3.2.6     | Exploits the Vitest UI server (`--ui`); this project never starts the UI server  |
| GHSA-fx2h-pf6j-xcff (high)     | `vite`   | ≥6.4.3     | `server.fs.deny` bypass via Windows alternate paths; CI and production run Linux |

CI enforces `pnpm audit --prod --audit-level=high`, which passes cleanly. Production runtime
dependencies are covered by `pnpm.overrides` in `package.json`. The full `pnpm audit
--audit-level=high` will report these advisories locally — that is expected and documented here.

Fixing them requires upgrading to vitest ≥3.2.6 (major version jump from 1.6.x). The upgrade is
deferred until the API surface can be validated against the full test suite.

#### §12.14 `minicoder test unit` — scope

`minicoder test unit` runs all Vitest test files except `*.integration.test.ts`. This includes
pure unit tests and the `packages/testing/src/testing.test.ts` scenario/fixture suite.
It is **not** limited to pure unit tests — the command name reflects the non-integration
Vitest tier, distinct from `test integration` (real-DB files) and `test system` (CLI scenarios).

#### SQLite test teardown — do not call `db.close()`

Never call `db.close()` in Vitest tests or scenario runner code. `better-sqlite3` registers native
GC finalizers for `Database` and `Statement` objects; explicit `db.close()` finalizes all
statements, causing a double-free SIGSEGV when V8's GC later runs the `Statement` finalizer.
The `vitest.config.ts` `pool: 'forks'` setting bypasses finalizers via `process.exit()` on
test-file completion. Let GC handle teardown naturally.
