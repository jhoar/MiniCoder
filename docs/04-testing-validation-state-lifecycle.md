# MiniCoder — Testing, Validation, and State Lifecycle Specification

> Status: Canonical
> Supersedes: minicoder_testing_validation_state_lifecycle_specification.md
> Version: 1.3.9
> Last-updated: 2026-07-05

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

**`minicoder db reset`'s enforced contract** (closed the Phase 1 warn-only gaps — see issues #10/#11):

| Requirement                     | Status                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit `--env` flag           | ✓ required; must be `development`, `test`, or `ci`                                                                                                                                                                                |
| Explicit `--yes` confirmation   | ✓ required with `--apply`                                                                                                                                                                                                         |
| System env cross-check          | ✓ `APP_ENV`/`NODE_ENV` checked; non-safe system value blocks reset regardless of `--env`                                                                                                                                          |
| `--env`/system-env agreement    | ✓ enforced — when a system env is set, `--env` must match it exactly, not just both be "safe"                                                                                                                                     |
| Unset-system-env handling       | ✓ enforced — an unset `APP_ENV`/`NODE_ENV` is never treated as safe; requires `--disposable-db`                                                                                                                                   |
| Credential safety               | ✓ PostgreSQL URL reduced to protocol+hostname+port+pathname; query string/fragment/creds dropped                                                                                                                                  |
| Malformed URL handling          | ✓ blocked with a fixed, non-sensitive error — never echoes the raw input                                                                                                                                                          |
| Database target identity        | ✓ PostgreSQL host checked against an allowlist (`MINICODER_ALLOWED_RESET_HOSTS`, default `localhost`/`127.0.0.1`/`::1`); non-listed hosts require explicit `--force-host`                                                         |
| Dry-run / two-step confirmation | ✓ `--dry-run` previews and issues a single-use, 5-minute confirmation token bound to the exact target; `--apply --confirmation <token>` performs the reset (mirrors `minicoder state repair`)                                     |
| Audit event                     | ✓ timestamped block (mode, env flag, system env, dialect, sanitized db, table count, actor, backup status)                                                                                                                        |
| Backup check                    | ✓ enforced — `--backup-verified` or `--backup-exempt "<reason>"` required, recorded in the audit log                                                                                                                              |
| Actor identity                  | ✓ enforced — `--actor <name>` required and recorded (Phase 1 has no session/role system, so this is a caller-declared identity, not an authenticated principal — the strongest this profile can offer; see docs/07 for real auth) |
| Scope restriction               | ✓ only owned tables dropped, no `CASCADE`                                                                                                                                                                                         |
| Guard-before-connect            | ✓ the guard runs and can `process.exit` before a SQLite file is created or a PostgreSQL connection is used                                                                                                                        |

```bash
# Step 1: preview and get a confirmation token (no mutation)
minicoder db reset --dry-run --env development --actor alice --backup-exempt "local dev db"

# Step 2: apply using the token from step 1
minicoder db reset --apply --yes --confirmation <token> --env development \
  --actor alice --backup-exempt "local dev db"
```

## 8. CI/CD Requirements

GitHub Actions runs lint, typecheck, unit tests, integration tests, migration validation, a system
test smoke scenario, a **security scan** (dependency audit, secret scan, SAST — see
[`00-glossary-and-terms.md`](00-glossary-and-terms.md) §7), Docker build, Docker Compose test (where
applicable), and Trigger.dev task deployment validation. Longer system tests may run nightly or on
release branches.

**Security scan job** (`.github/workflows/ci.yml`'s `security-scan`, issue #12) runs four checks,
every third-party action/tool pinned to a commit SHA or image digest, with least-privilege
`permissions: contents: read` (workflow-wide, plus the job's own explicit block) and no
`pull_request_target` — forked-repo PRs never receive repository secrets:

| Check            | Tool                                      | Local reproduction                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency audit | `pnpm audit --prod --audit-level=high`    | `pnpm audit --prod --audit-level=high` (full non-`--prod` audit reports the one remaining accepted dev-only advisory — §12.13)                                                                                        |
| Dependency audit | OSV Scanner (`google/osv-scanner-action`) | `osv-scanner --lockfile=pnpm-lock.yaml --recursive`                                                                                                                                                                   |
| Secret scan      | gitleaks (`gitleaks/gitleaks-action`)     | `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.30.1 detect --source /repo --redact -v`                                                                                                                      |
| SAST             | semgrep (pinned image digest)             | `docker run --rm -v "$PWD:/src" -w /src semgrep/semgrep@sha256:ae27024c16f7848cdbfd49c24ed0b78b13f13b85fcd7b87c679aaa8b0c0dce98 semgrep scan --config p/security-audit --config p/typescript --error --metrics=off .` |

**Suppression policy:** gitleaks findings are suppressed only via an inline `.gitleaksignore`
entry with a commit-linked rationale; semgrep findings are suppressed only via an inline
`// nosemgrep: <rule-id> -- <reason>` comment at the flagged line. Neither tool uses a blanket
rule/path exclusion — every suppression is visible in the PR diff that introduces it.

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

**Safety contract** — the runner enforces all of the following before any mutation (issues #10/#11
closed the previous warn-only gaps):

| Check                    | Enforcement                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two-step confirmation    | `--dry-run` previews and issues a single-use, 5-minute confirmation token bound to the exact db target; `--apply --confirmation <token> --yes` performs the reset                                   |
| Explicit `--env` flag    | Required; value must be `development`, `test`, or `ci`                                                                                                                                              |
| System env cross-check   | `APP_ENV`/`NODE_ENV` checked; a non-safe system value blocks reset regardless of `--env`; when set, `--env` must match it exactly                                                                   |
| Unset system env         | Never treated as safe by default — requires the explicit `--disposable-db` acknowledgment                                                                                                           |
| Actor identity           | `--actor <name>` required and recorded in the audit log (Phase 1 has no session/role system — this is a caller-declared identity, the strongest this profile can offer; real auth is docs/07 scope) |
| Backup evidence          | `--backup-verified` or `--backup-exempt "<reason>"` required and recorded                                                                                                                           |
| Database target identity | PostgreSQL host checked against `MINICODER_ALLOWED_RESET_HOSTS` (default `localhost`/`127.0.0.1`/`::1`); other hosts require explicit `--force-host`                                                |
| Credential safety        | PostgreSQL connection URL reduced to protocol+hostname+port+pathname before logging — query string, fragment, and credentials are dropped entirely, not just the URL authority                      |
| Malformed URL handling   | Blocked with a fixed, non-sensitive error; the raw input is never echoed                                                                                                                            |
| Audit event              | Printed to stdout before mutation: timestamp, mode, env flag, system env, dialect, sanitized database identifier, table count, actor, backup status                                                 |
| Dry-run summary          | Tables to be dropped listed before execution                                                                                                                                                        |

**Never run against production.** PostgreSQL: use a dedicated development/CI database or a
separate schema. SQLite: use a throw-away file (`/tmp/dev.db`).

```bash
# SQLite — step 1: preview and get a token
DB_DIALECT=sqlite DB_PATH=./dev.db \
  tsx packages/migrations/src/runner.ts reset --dry-run --env development \
  --actor alice --backup-exempt "local dev db"

# SQLite — step 2: apply
DB_DIALECT=sqlite DB_PATH=./dev.db \
  tsx packages/migrations/src/runner.ts reset --apply --yes --confirmation <token> \
  --env development --actor alice --backup-exempt "local dev db"

# PostgreSQL (host must be in MINICODER_ALLOWED_RESET_HOSTS, or pass --force-host)
DB_DIALECT=postgres DB_URL=postgresql://user:pass@localhost:5432/devdb \
  tsx packages/migrations/src/runner.ts reset --dry-run --env development \
  --actor alice --backup-exempt "local dev db"
DB_DIALECT=postgres DB_URL=postgresql://user:pass@localhost:5432/devdb \
  tsx packages/migrations/src/runner.ts reset --apply --yes --confirmation <token> \
  --env development --actor alice --backup-exempt "local dev db"

# CI (APP_ENV is advisory; --env flag is required regardless; CI runners should set
# APP_ENV=ci or NODE_ENV=ci rather than relying on --disposable-db)
DB_DIALECT=sqlite DB_PATH=/tmp/ci.db \
  tsx packages/migrations/src/runner.ts reset --dry-run --env ci --actor ci-runner --backup-exempt "ephemeral CI db"
```

Expected output: audit block (dry-run mode issues a confirmation token and exits without
mutating), then on `--apply`: audit block, table list, "Dropped N owned tables", migration output.

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

#### Image pinning (issue #16)

`triggerdev-webapp`, `triggerdev-supervisor`, and `triggerdev-docker-proxy` are pinned to
immutable SHA-256 digests, not mutable tags (`v4-beta`/`latest` could otherwise silently change
between pulls, breaking reproducibility and creating a supply-chain risk). Each `image:` line
carries a trailing comment with the human-readable tag it was captured from and the capture date.

To re-pin deliberately (e.g. when upgrading Trigger.dev):

```bash
# Get an anonymous pull token and the manifest digest for a given image:tag
TOKEN=$(curl -sS "https://ghcr.io/token?service=ghcr.io&scope=repository:triggerdotdev/trigger.dev:pull" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -sS -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.index.v1+json" \
  -I "https://ghcr.io/v2/triggerdotdev/trigger.dev/manifests/v4-beta" | grep docker-content-digest
```

(For Docker Hub images such as `tecnativa/docker-socket-proxy`, use
`https://auth.docker.io/token?service=registry.docker.io&scope=repository:<repo>:pull` for the
token and `https://registry-1.docker.io/v2/<repo>/manifests/<tag>` for the manifest request.)

Update the `image:` line to `<repo>@sha256:<digest>`, keep the tag/date in the trailing comment,
and validate with `docker compose -f infra/docker-compose.triggerdev.yml config` before committing.
`triggerdev-webapp` and `triggerdev-supervisor` track the same Trigger.dev release channel and
should be re-pinned together. `triggerdev-docker-proxy`'s `:latest` pin should be revisited once
the project identifies a stable release tag to track instead.

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
> - All other `minicoder trigger` commands — exit 1 ("not implemented"). These require a real
>   Trigger.dev **management**-API client (`TRIGGERDEV_API_URL`/`TRIGGERDEV_API_KEY`), which
>   Phase 13 deliberately left out of scope (a different, external system from the Orchestrator
>   API Phase 13 built — see CLAUDE.md's Orchestrator API Operational Constraints). `list-runs`
>   and `inspect-run` return static placeholder JSON only, not live data.
> - `minicoder state` commands (`doctor`, `reconcile`, etc.) are implemented (Phase 4), and their
>   query logic is now also exposed via the Orchestrator API's diagnostics command endpoints
>   (Phase 13).

#### Procedure: Deploy tasks

```bash
pnpm --filter @minicoder/triggerdev build
minicoder trigger validate        # confirm all 9 task IDs present

# Direct CLI (minicoder trigger deploy remains unimplemented — see the CLI command status note above):
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

#### CI Registry Setup (issue #18)

`trigger-deploy.yml`'s `deploy-tasks` job needs a real, externally-reachable Docker registry when
it runs on GitHub-hosted runners — `DEPLOY_REGISTRY_HOST` (the CLI's push target) and
`DOCKER_REGISTRY_URL` (the supervisor's pull source, read from `infra/docker-compose.triggerdev.yml`'s
env) must resolve to the **same** registry (CLAUDE.md's Trigger.dev Operational Constraints), and
neither can default to `localhost:5000`/`triggerdev-registry:5000` once the CLI push and the
supervisor pull happen from different network namespaces (a GitHub-hosted CI runner vs. wherever
the compose stack's `triggerdev-registry`/`triggerdev-supervisor` containers actually run).

**External registry vs. the bundled `triggerdev-registry` service — the actual decision:**
`infra/docker-compose.triggerdev.yml`'s bundled `registry:2` container (service name
`triggerdev-registry`) is the right default for local/single-node development, where the CLI push
and the supervisor pull both happen on the same Docker host and can use the internal hostname
`triggerdev-registry:5000` — no external registry is needed there. It stops being sufficient the
moment CI (or any topology where the deploying CLI and the running supervisor are on different
hosts/networks) enters the picture: a GitHub-hosted runner has no route to a bundled registry
container running inside someone else's compose stack. In that case, both `DEPLOY_REGISTRY_HOST`
and `DOCKER_REGISTRY_URL` must point at one externally-reachable registry instead — either a
managed one (ghcr.io, Docker Hub) or a self-hosted one exposed on a public/VPN-reachable address.
There is no in-between "half-bundled" option: pick one registry both the pusher and the puller can
reach, and point both variables at it.

**Required secrets/variables** (set as GitHub Actions repository or environment variables/secrets,
consumed by `trigger-deploy.yml` and the `docker-compose.triggerdev.yml` stack the supervisor runs
against):

| Name                   | Kind     | Purpose                                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `DEPLOY_REGISTRY_HOST` | Variable | Registry host:port the CLI pushes task images to                                                                    |
| `DOCKER_REGISTRY_URL`  | Variable | Registry URL the supervisor pulls task images from — must match the above                                           |
| `REGISTRY_USERNAME`    | Secret   | Registry auth (ghcr.io: a GitHub PAT or `GITHUB_TOKEN` with `write:packages`; Docker Hub: your Docker Hub username) |
| `REGISTRY_PASSWORD`    | Secret   | Registry auth password/token paired with `REGISTRY_USERNAME`                                                        |
| `TRIGGER_ACCESS_TOKEN` | Secret   | Trigger.dev API auth (already required, listed here for completeness)                                               |
| `TRIGGER_API_URL`      | Variable | Trigger.dev API endpoint (already required)                                                                         |
| `TRIGGER_PROJECT_REF`  | Variable | Trigger.dev project reference (already required)                                                                    |

**Example: ghcr.io**

```yaml
env:
  DEPLOY_REGISTRY_HOST: ghcr.io/<org>/<repo>-triggerdev
  DOCKER_REGISTRY_URL: https://ghcr.io/<org>/<repo>-triggerdev
```

Authenticate the CLI's push step with `docker login ghcr.io -u <org> -p "$REGISTRY_PASSWORD"`
before the deploy step (a GitHub Actions `GITHUB_TOKEN` with `packages: write` permission works for
same-repo pushes; a cross-repo/PAT is required otherwise). The supervisor's pull-side
authentication is a separate concern — configure `docker login` (or the registry's pull-credential
mechanism) on whatever host runs `triggerdev-supervisor` before it needs to pull a newly deployed
image.

**Example: Docker Hub**

```yaml
env:
  DEPLOY_REGISTRY_HOST: docker.io/<org>/minicoder-triggerdev
  DOCKER_REGISTRY_URL: https://index.docker.io/v1/
```

Same pattern: `docker login -u "$REGISTRY_USERNAME" -p "$REGISTRY_PASSWORD"` before push; configure
pull credentials on the supervisor's host separately.

**Topology verification steps** (do this once when standing up a new CI registry configuration,
and whenever `DEPLOY_REGISTRY_HOST`/`DOCKER_REGISTRY_URL` change):

1. From the CI runner (or a shell with equivalent network access), confirm the registry resolves
   and accepts the push credential: `docker login <registry-host>` followed by a test
   `docker push` of any small image.
2. From the host running `triggerdev-supervisor`, confirm it can reach and pull from the same
   registry: `docker pull <registry-host>/<any-pushed-image>`.
3. Confirm both variables name the **same host** — a mismatch (e.g. CI pushes to
   `ghcr.io/org/repo` while the supervisor is still configured with the bundled
   `triggerdev-registry:5000` default) is the most common failure mode, and looks like "deploy
   succeeded" followed by the supervisor's runner containers failing to start with an
   image-not-found error.
4. Run `docker compose -f infra/docker-compose.triggerdev.yml config` to confirm the resolved
   `DOCKER_REGISTRY_URL` value actually matches what was set, before relying on it in a live
   deployment — this is the same syntax-validation substitute this repository already uses
   elsewhere when no live Docker daemon is available to exercise the stack end-to-end.

`trigger-deploy.yml`'s `validate-tasks` job now includes a registry-topology smoke-test step
(below) that fails fast on a same-registry mismatch **before** the deploy job spends time pushing
images against a configuration that would strand the supervisor.

#### Procedure: Queue drain (CI / pre-deploy)

All `minicoder trigger` queue commands exit 1 (a real Trigger.dev management-API client remains
unbuilt — see the CLI command status note above). Monitor queue state via the
Trigger.dev webapp at `http://localhost:3040`. Wait for all runs to reach a terminal state before
running destructive operations or schema migrations.

#### Procedure: Inspect and replay a failed run

Use the Trigger.dev webapp at `http://localhost:3040` to view run history, inspect payloads, and
trigger replays. There is no supported CLI sub-command for replay in the current Trigger.dev v4
CLI; the webapp remains the authoritative interface — `minicoder trigger replay-run` requires a
Trigger.dev management-API client that remains unbuilt (see the CLI command status note above).

#### Procedure: Cancel a stuck run

Use the Trigger.dev webapp at `http://localhost:3040` to cancel individual runs. There is no
supported `cancel` CLI sub-command in the current Trigger.dev v4 CLI. `minicoder trigger
cancel-run` remains unimplemented for the same reason.

#### Procedure: Reconcile DB vs live runs

`minicoder trigger reconcile` remains unimplemented. Manually compare `triggerdev_runs`
rows with status `running` against the Trigger.dev webapp run list and update stale rows directly
in the database. `minicoder state reconcile` already automates the workflow-state side of this
reconciliation, and the Orchestrator API's `POST /commands/reconcile` (Phase 13) exposes the same
logic over HTTP.

#### Procedure: Dev reset (dev/CI only)

> `minicoder trigger reset-dev` is not yet implemented (requires a Trigger.dev management-API
> client, out of Phase 13's scope). In the interim, use Docker
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

#### Procedure: Recovering from a permanently-lost initial `pr.opened` webhook

The scheduled `github-reconciliation` fallback only re-checks feature runs that already have a
`pull_requests` row (see the "Feature run stuck, no `pull_requests` row" diagnostic above, and the
`GitHubClient.listPullRequestsForBranch`-scope note in `github-reconciliation.ts`'s JSDoc and
docs/01 §5.7). If the _initial_ `pr.opened` webhook delivery for a feature run is permanently lost
— not merely delayed — and the repository's GitHub App/webhook delivery history confirms it never
arrived, there is currently no automated self-heal path. This is a narrower situation than a
generic "reconciliation didn't run" symptom: the run is not diverging from a tracked PR, it simply
has no tracked PR at all.

**Detection**: a `minicoder/FR-*` branch has an open pull request on GitHub, but
`SELECT * FROM pull_requests WHERE feature_run_id = '<id>'` returns no row, and the feature run's
`feature_runs.current_execution_state` has remained at `code_pushed` (or `pr_opened`, if a
different, still-tracked PR ever briefly matched) for longer than the branch/PR has visibly existed
on GitHub. `minicoder state doctor`'s existing checks do not catch this specific case — none of its
checks compare local `feature_runs` state against GitHub's actual PR list, only against already-
tracked `pull_requests` rows — so this requires operator inspection (GitHub UI or `gh pr list`
against the branch), not automated detection.

**Recovery (interim, manual)**: no Orchestrator API command for this exists — it requires the
still-unbuilt `GitHubClient.listPullRequestsForBranch`-style discovery method (deferred to a future
phase; not added in Phase 13, see the "Alternatives considered and deferred" note below) — and
`minicoder github simulate-pr-opened` is a dev/test/CI-only command —
it calls `guardEnv()`, which hard-rejects when `APP_ENV`/`NODE_ENV` is `production` regardless of
any `--env` flag (see CLAUDE.md's dev/test-only command safety guards), so it cannot be used to
repair a production deployment. The only currently-available production-safe recovery is a direct,
careful manual insert into `pull_requests` via `minicoder db` tooling (or an equivalent scoped SQL
client under the same access controls), using the real values from the GitHub PR:

1. Confirm the real PR's `pr_number`, `head.ref` (→ `branch_name`), `base.ref` (→ `base_branch`),
   and `head.sha` (→ `head_sha`) from the GitHub UI or `gh pr view <number> --json number,headRefName,baseRefName,headRefOid`.
2. Insert one row into `pull_requests`. `id` is a plain `TEXT PRIMARY KEY` with **no default** (see
   migration `0009_pull_requests` — unlike `created_at`/`updated_at`, which default to the current
   timestamp) and no format constraint: any unique string works, matching what the application's
   own `generateId()` helper produces at runtime (`` `${Date.now()}-${randomBase36}` ``, e.g.
   `1783020000000-a1b2c3d4` — not a UUID, despite superficially looking like one). Use the exact
   column set below (`conversations_resolved` is `BOOLEAN` on PostgreSQL, `INTEGER` 0/1 on SQLite —
   use whichever your deployment's `minicoder db` backend expects):

   ```sql
   INSERT INTO pull_requests
     (id, feature_run_id, pr_number, branch_name, base_branch, head_sha,
      state, review_state, ci_status, blocking_labels, conversations_resolved, version)
   VALUES
     ('<generate-a-unique-id>', '<feature_run_id>', <pr_number>, '<branch_name>', '<base_branch>',
      '<head_sha>', 'open', 'none', 'pending', '[]', false, 1);
   ```

   `created_at`/`updated_at` can be omitted — both default to the current timestamp (migration
   `0009_pull_requests`) — or set explicitly if your SQL client requires listing every column.
   `review_state`/`ci_status` are seeded at their neutral defaults deliberately: reconciliation
   corrects both to GitHub's real observed values on its next pass, so there is no need (and no
   need to query GitHub twice) to pre-populate them accurately here.

3. Do not set `feature_runs.current_execution_state` directly; leave it at whatever it currently is
   (typically `code_pushed`). The next scheduled `github-reconciliation` pass (or the next webhook
   delivery for this PR, e.g. a subsequent `check_suite`/`pull_request_review` event) picks the run
   up normally via the now-existing `pull_requests` row and reconciles state forward through the
   ordinary `reconcileGithubState()` path — this manual insert only creates the tracking row, it
   never substitutes for a real reconciliation pass.

This is documented as an interim, manual operator procedure, not a polished feature. Building a
`GitHubClient.listPullRequestsForBranch`-style discovery method (so the scheduled fallback could
find a never-tracked PR on its own and eliminate the need for step 1–3 above) remains explicitly
out of scope here — it is a larger, separate capability than this runbook gap warrants and is
already called out as unbuilt in the code's own comments.

**Alternatives considered and deferred (reaffirmed, round 8):** automated discovery for this gap
has been raised across multiple review rounds; the decision to defer it stands, for these reasons:

- **`GitHubClient.listPullRequestsForBranch`-style discovery** — the most direct fix, but a
  genuinely new capability (a paginated GitHub API surface plus a scheduled-task call site), not a
  bug fix to the existing reconciliation path; still deferred to a future phase (Phase 13 built the
  Orchestrator API's read/command/webhook surface but did not add this GitHub discovery method).
- **A `state doctor` check** — not currently feasible without giving the CLI a live GitHub
  credential and making a per-run API call; none of `state doctor`'s existing checks call out to
  GitHub today, they only compare already-persisted local tables against each other.
- **An alerting mechanism** — would need a staleness heuristic (how long is "stuck too long" for a
  branch that might legitimately sit at `code_pushed` for a while) and a notification channel,
  neither of which exists in the current operational tooling.
- **A guarded repair command** — closest in spirit to the manual SQL insert above, but formalizing
  it as a `minicoder`/Orchestrator-API command depends on the same discovery method above and
  remains deferred to a future phase alongside it.

This is Medium-severity operational-completeness scope, not a correctness bug: reconciliation
behaves correctly for every PR it knows about, and the manual runbook above (introduced in round 6,
corrected in round 7) is the accepted interim mitigation until one of the above is built.

### Phase 8 — Execution Orchestrator Runbook

This runbook covers the manual recovery procedures for the sequential feature-selection and
budget-gate primitives delivered in Phase 8 (`packages/core/src/commands/handlers/{automation,
feature}/`, `packages/core/src/cost/`). **Phase 13 update:** `PauseAutomationCommand`,
`ResumeAutomationCommand`, and `ApproveBudgetOverrideCommand` are now reachable via the
Orchestrator API's generic command dispatch route (`POST /commands/pause-automation`,
`POST /commands/resume-automation`, `POST /commands/approve-budget-override`, each requiring an
`Idempotency-Key` header and an operator/approver-role API key) — the direct-dispatch procedures
below remain valid (and are still the only path for a CLI/script-based operator without API
access), but a live deployment should prefer the API endpoints going forward.

#### Procedure: Resume automation stuck in a paused state

`workflow_states.automation_state` can be `paused_by_operator`, `paused_budget_exceeded`, or
`waiting_for_budget_approval` (glossary §3.8). Confirm which one first:

```sql
SELECT automation_state, version, active_feature_run_id FROM workflow_states WHERE project_id = '<id>';
```

- **`paused_by_operator`** clears via `ResumeAutomationCommand` (operator actor), idempotency key
  `resume-automation:{projectId}:{expectedVersion}`.
- **`paused_budget_exceeded`** or **`waiting_for_budget_approval`** clears via
  `ApproveBudgetOverrideCommand` (approver actor) — the same command serves both matrix edges;
  the `StateTransitionValidator` resolves the correct transition from the current
  `automation_state` automatically. Pick the idempotency key matching the state you observed:
  `budget-override:{projectId}:{expectedVersion}` from `paused_budget_exceeded`,
  `budget-override-waiting:{projectId}:{expectedVersion}` from `waiting_for_budget_approval`.

Without API access, dispatch them directly against
`ApproveBudgetOverrideHandler`/`ResumeAutomationHandler` via `TransactionalCommandExecutor` from an
operator script, supplying the current `workflow_states.version` as both `expectedVersion` in the
payload **and** the `{expectedVersion}` idempotency-key discriminator above. A project can
legitimately be paused/resumed or breach/overridden more than once over its lifetime — omitting
the version discriminator and reusing a `{projectId}`-only key recreates the idempotency
collision fixed in a prior Phase 8 code-review round (a stale cached result would be returned
instead of executing the new transition).

#### Procedure: Inspect current spend vs. a budget policy by hand

`evaluateBudget()` (`packages/core/src/cost/budget-evaluator.ts`) computes its verdict with a live
`SUM(cost_records.amount)` — reproduce it manually:

```sql
-- Active policy for a scope (project | feature | review_cycle)
SELECT * FROM budget_policies
WHERE project_id = '<id>' AND scope = '<scope>' AND is_active = 1
  AND (feature_request_id = '<fr_id>' OR feature_request_id IS NULL);

-- Cumulative spend for the same scope (add a recorded_at >= <cutoff> clause if the policy has
-- a window_days value)
SELECT COALESCE(SUM(amount), 0) AS total FROM cost_records
WHERE project_id = '<id>' AND scope = '<scope>' [AND feature_request_id = '<fr_id>'];
```

`total >= hard_limit` is a hard breach; otherwise `total >= soft_limit` is a soft breach; hard is
checked first, so a policy breaching both limits reports as hard.

#### Procedure: Recover a stuck `active_feature_run_id` pointer

`workflow_states.active_feature_run_id` is set by `SelectFeatureHandler`'s atomic conditional
`UPDATE` and is not automatically cleared except by the feature run completing. **There is no
automatic reconciliation for this in Phase 8** — a crashed worker, a feature run wedged in
`human_required`/`failed`/`system_failed` with no subsequent unblock, or an operator directly
editing `feature_runs` can leave `active_feature_run_id` pointing at a feature run that will never
naturally advance, permanently blocking `start-next-feature` from selecting anything else for that
project. This is a known limitation, not a silently-accepted gap — flagged here so it is not
mistaken for automated self-healing.

**Detection**: `active_feature_run_id` is non-`NULL` but the referenced `feature_runs` row has sat
at `human_required`, `failed`, `blocked`, or `system_failed` for longer than expected, with no
active work in progress.

**Recovery (manual)**:

```sql
UPDATE workflow_states
SET active_feature_run_id = NULL, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE project_id = '<id>' AND active_feature_run_id = '<stuck_feature_run_id>';
```

Only clear the pointer once the stuck feature run's disposition is resolved (a human has
retried/skipped/blocked it via the escalation path) — clearing it prematurely while the feature
run is genuinely still in progress would let `start-next-feature` select a second concurrently
active feature, defeating the single-active-feature invariant this column exists to enforce.

### Phase 9 — Reference Coder Adapter Runbook

Covers manual recovery/inspection for the coder-adapter pipeline delivered in Phase 9
(`packages/adapters-coder`, `packages/triggerdev/src/tasks/run-coder.ts`,
`infra/docker-compose.coder-sandbox.yml`). **Phase 13 update:** `POST /commands/request-coder-run`
now exists as an "enqueue" API endpoint (returns `{triggerdevRunId, accepted}` and requires an
injected `TaskTriggerClient` at server startup — see CLAUDE.md's Orchestrator API Operational
Constraints); the direct task-invocation/SQL-inspection procedures below remain the only path when
running outside a live Orchestrator API deployment.

#### Procedure: Start the coder sandbox infrastructure

```bash
docker compose -f infra/docker-compose.coder-sandbox.yml up -d
docker build -t minicoder/coder-sandbox:latest infra/docker/coder-sandbox
```

Set `CODER_SANDBOX_DOCKER_HOST=tcp://<host>:2375` (the `coder-sandbox-docker-proxy` service) and
`CODER_SANDBOX_HTTPS_PROXY=http://<host>:8888` (the `coder-sandbox-egress-proxy` service) in the
environment `run-coder`'s default resolver reads. **This stack has not been exercised against a
live Docker daemon in this repository's CI** (see docs/06 Phase 9 "Deviations from the original
plan" and docs/07 §6's "Phase 9 implementation status") — treat a first real deployment as the
verification pass, not as a known-working reference.

#### Procedure: Recover a feature run stuck at `coding` with no `agent_runs` row

`run-coder` is a separate, scheduled/triggered task from `start-next-feature` — a feature run can
reach `coding` and then never be picked up if the scheduler/webhook that should invoke `run-coder`
is misconfigured or down. Detect it:

```sql
SELECT fr.id, fr.current_execution_state
FROM feature_runs fr
LEFT JOIN agent_runs ar ON ar.feature_run_id = fr.id
WHERE fr.current_execution_state = 'coding' AND ar.id IS NULL;
```

Recovery is invoking the task directly with the stuck `featureRunId` (no state mutation needed
first — `run-coder` reads the current state itself and no-ops if it isn't at `coding`):

```ts
import { runRunCoder } from '@minicoder/triggerdev';
// coderAdapterName is required (no default — see CLAUDE.md's Reference Coder Adapter Operational
// Constraints, MEDIUM-3): use the production registry name (e.g. 'CodexCoderAdapter'), not a mock.
await runRunCoder(
  { projectId, featureRunId, correlationId, idempotencyKey, coderAdapterName: 'CodexCoderAdapter' },
  db,
);
```

#### Procedure: Inspect a coder run's full provenance

```sql
SELECT id, state, provider, model, tokens_used, cost_usd, error FROM agent_runs WHERE feature_run_id = '<id>';
SELECT content, content_schema_version FROM agent_context_packs WHERE agent_run_id = '<agent_run_id>';
SELECT tool_name, status, duration_ms FROM agent_tool_operations WHERE agent_run_id = '<agent_run_id>' ORDER BY occurred_at;
SELECT scope, amount, provider, model, input_tokens, output_tokens FROM cost_records WHERE agent_run_id = '<agent_run_id>';
```

A `state = 'failed'` row's `error` column plus the matching `agent_errors.error_type` row is the
first place to look for why a coder run didn't reach `code_pushed`.

#### Procedure: Retry pull-request creation after a logged, non-fatal failure

`run-coder` logs (does not throw) a `GitHubClient.createPullRequest` failure once the feature run
has already reached `code_pushed` — the push itself is not rolled back. Confirm the feature run is
at `code_pushed` with no tracked `pull_requests` row, then either wait for the next scheduled
`github-reconciliation` pass (it does not discover brand-new PRs, only re-checks tracked ones — see
the GitHub Integration Operational Constraints section of CLAUDE.md) or call
`GitHubClient.createPullRequest` directly with the branch name recorded in the
`feature.code_pushed` `workflow_events` row's payload.

### Phase 11 — Disagreement, Arbiter, and Human Escalation Runbook

Covers manual recovery/inspection for the disagreement-detection and human-escalation machinery
delivered in Phase 11 (`packages/core/src/disagreement/`, the five `human_required` exit command
handlers, `minicoder human ...`). **Phase 13 update:** all five handlers
(`ResolveDisagreementCommand`, `ResumeFeatureExecutionCommand`, `RetryFeatureCommand`,
`SkipFeatureCommand`, `BlockFeatureCommand`) are now also reachable via the Orchestrator API's
generic command dispatch route (`POST /commands/{resolve-disagreement,resume-feature-execution,
retry-feature,skip-feature,block-feature}`), in addition to `minicoder human ...`.

#### Procedure: Find feature runs stuck at `human_required`

```sql
SELECT fr.id, fr.current_execution_state, fr.fix_attempt_count, freq.fr_id
FROM feature_runs fr
JOIN feature_requests freq ON fr.feature_request_id = freq.id
WHERE fr.current_execution_state = 'human_required';
```

For each, check whether it has an open (or Arbiter-escalated) disagreement to inform which
disposition applies:

```sql
SELECT id, state, review_cycle, resolution FROM disagreement_records
WHERE feature_run_id = '<feature_run_id>' AND state IN ('open', 'escalated')
ORDER BY review_cycle DESC LIMIT 1;
```

#### Procedure: Disposition a `human_required` feature run

All five dispositions require `--project`, `--feature-run`, `--actor`, and either `--resolution`
(resolve-disagreement) or `--notes` (the other four). `--actor-role` defaults to `approver`.

```bash
# A disagreement exists and the reviewer's finding is correct — fix required
minicoder human resolve-disagreement --feature-run <id> --project <id> --actor <you> \
  --resolution "reviewer finding stands, fix required"

# The escalation is dismissed — no fix needed; use --disagreement if resolving in the coder's favor
minicoder human resume --feature-run <id> --project <id> --actor <you> \
  --notes "false positive, dismissing" [--disagreement <id>]

# Retry automation from the top — only valid while this run is still the project's active feature
minicoder human retry --feature-run <id> --project <id> --actor <you> \
  --notes "transient infra failure, retrying"

# Abandon automation for this feature entirely (terminal — see docs/00 §3.3's known limitation on
# downstream feature_dependencies never clearing)
minicoder human skip --feature-run <id> --project <id> --actor <you> \
  --notes "descoped, will not be automated"

# An external precondition must be satisfied first (known limitation: UnblockFeatureCommand's
# guard only checks feature_dependencies, not a human-set block — recovering a human-blocked
# feature with no unmet dependency currently requires `minicoder state repair`)
minicoder human block --feature-run <id> --project <id> --actor <you> \
  --notes "waiting on an external API key"
```

Each writes a `human_approvals` row (queryable via `SELECT * FROM human_approvals WHERE
feature_run_id = '<id>' ORDER BY decided_at DESC`) and a `workflow_events`/`outbox_events` pair
(`feature.disagreement_resolved` / `feature.resumed_from_human_required` / `feature.retried` /
`feature.skipped` / `feature.blocked_by_human`).

#### Procedure: `retry` rejected with `not-active-feature-run`

`RetryFeatureCommand` only applies to the project's current `workflow_states.active_feature_run_id`
— retrying a different (non-active) feature run at `human_required` would strand it at `selected`
with nothing to ever pick it up. If the feature run you want to retry isn't the active one, this is
a signal that `start-next-feature` already moved on; a direct `minicoder state repair` is the
recovery path, not a retry.

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
- `merge-gate` — four feature runs covering every Merge Gate outcome (Phase 12): a clean
  `under_review` run that reaches `approved_by_policy`/`merge_ready`/`merged`; a rejected gate
  (unresolved blocking finding); an `approved_by_policy` run whose simulated GitHub merge fails
  with a `sha_mismatch` (auto-clears back to `under_review`); and one whose merge fails with
  `not_mergeable` (escalates to `human_required`)
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

The doctor runs 6 checks:

| Check                 | Severity | Auto-clearable      |
| --------------------- | -------- | ------------------- |
| `stale_locks`         | error    | yes                 |
| `stuck_outbox`        | error    | yes                 |
| `stuck_inbox`         | error    | yes                 |
| `orphaned_runs`       | error    | manually repairable |
| `triggerdev_mismatch` | warning  | no (future phase)   |
| `skipped_dependency`  | error    | manually repairable |

`skipped_dependency` (issue #52) flags a feature run at `approved_pending_execution` whose
`feature_dependencies` target has been transitioned to `skipped` — a state that can never satisfy
the "merged" dependency guard. `SkipFeatureHandler` proactively transitions any such dependent to
`blocked` at skip time (a new `approved_pending_execution -> blocked` matrix row), so this check
exists mainly as defense-in-depth for cases that predate that fix, surfaced via `blocked`
diagnostics going forward instead.

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

`vitest`/`@vitest/coverage-v8` were upgraded from `^1.6.0` to `^3.2.6` (issue #22), which resolves
the previously-accepted **critical** vitest advisory (GHSA-5xrq-8626-4rwp) outright — vitest 3.2.6
no longer reports it. One advisory remains, transitively pulled in via vitest 3.2.6's bundled vite
5.4.x, and is still accepted as non-exploitable in this project:

| Advisory                   | Package | Patched at | Why not exploitable here                                                         |
| -------------------------- | ------- | ---------- | -------------------------------------------------------------------------------- |
| GHSA-fx2h-pf6j-xcff (high) | `vite`  | ≥6.4.3     | `server.fs.deny` bypass via Windows alternate paths; CI and production run Linux |

Fully resolving this one would require vitest 4.x (which bundles a vite major satisfying the
patched range) — a further major-version jump than issue #22 called for (`≥3.2.6`), deferred as a
separate, deliberate future upgrade rather than bundled into this one, since vitest 4's peer
requirements (`vite ^6 || ^7 || ^8`) and config-schema changes weren't validated in this pass.

CI enforces `pnpm audit --prod --audit-level=high`, which passes cleanly (`1 low | 5 moderate`, all
below the `high` gate). Production runtime dependencies are covered by `pnpm.overrides` in
`package.json`. The full `pnpm audit --audit-level=high` will still report the one remaining vite
advisory locally — that is expected and documented here.

#### §12.14 `minicoder test unit` — scope

`minicoder test unit` (`vitest.unit.config.ts`) runs all Vitest test files except
`*.integration.test.ts` **and** everything under `packages/testing/src/**` (issue #23). The
latter exclusion is deliberate: that directory holds scenario/fixture tests
(`runAllScenarios()`-style system scenarios, Postgres-gated integration suites, multi-package
test-DB fixtures) rather than pure domain-logic unit tests, and excluding the whole directory
(rather than an allowlist of specific non-scenario files in it) is the least brittle option — no
list to keep in sync as new scenario files are added. Scenario coverage remains fully reachable
via `minicoder test system` (`runAllScenarios()`, independent of this Vitest config entirely) and
via `pnpm test`/CI, which run the root `vitest.config.ts` and are unaffected by this exclusion.
`test unit` is now scoped to what its name promises: pure unit tests, distinct from
`test integration` (real-DB `*.integration.test.ts` files) and `test system` (CLI scenarios).

#### §12.15 Concurrency scenario tier (issue #43) — PostgreSQL-only, by design

`packages/testing/src/execution-orchestrator-concurrency.postgres.test.ts` adds a new test tier:
genuinely concurrent (`Promise.all`-driven, not sequential) multi-actor scenarios exercising
`start-next-feature`, `github-reconciliation`, and an operator `PauseAutomationCommand` against
the same project simultaneously, asserting the single-active-feature and no-lost-transition
invariants documented in CLAUDE.md's Execution Orchestrator Operational Constraints.

This tier is **PostgreSQL-only**, gated by `MINICODER_TEST_PG_URL` (same gate as
`runner.postgres.test.ts`/`registry.postgres.test.ts`), not a SQLite scenario under
`packages/testing/src/*.test.ts`. This is a deliberate architectural finding, not a convenience
choice: `better-sqlite3` is a fully synchronous native binding running on Node's single thread, so
two `SqliteDbClient` connections to the same file cannot genuinely race — whichever connection's
blocking write call runs first monopolizes the only thread until it returns, so an overlapping
write from a second connection either never actually overlaps (no real race exercised) or
deadlocks against `busy_timeout` (the first connection can never reach `COMMIT` while the second's
synchronous busy-wait is blocking the only thread that could run it). A multi-connection
same-file SQLite version of this exact scenario was built and empirically deadlocked on
"database is locked" every iteration before this Postgres-gated version replaced it. PostgreSQL's
client-server architecture has no such limitation — each `pg.Pool` connection is a genuinely
independent backend process, so concurrent transactions here exercise real overlapping writes the
way a production hosted/team deployment actually would. Locally, with no `MINICODER_TEST_PG_URL`
set, this suite reports as skipped (same posture as the other Postgres-gated suites) — it runs for
real in CI's postgres job.

**Issue #41** adds a second suite in the same tier,
`packages/testing/src/phase8-concurrency-guards.postgres.test.ts`, covering the specific Phase 8
concurrency guards CLAUDE.md's Execution Orchestrator Operational Constraints document, each
proven against real concurrent PostgreSQL connections rather than sequential re-dispatch: (1)
`SelectFeatureHandler`'s `workflow_states.active_feature_run_id` compare-and-swap (exactly one of
two concurrent `SelectFeatureCommand`s wins, the other gets `feature-already-active`); (2)
`StartCodingHandler`'s atomic `automation_state = 'running'` re-check racing a concurrent
`PauseAutomationCommand` (the two outcomes — coding started under `running`, or coding rejected
with `automation-paused` — are proven mutually exclusive and exhaustive, never both "winning"); (3)
the `idempotency_keys` claim-first `INSERT ... ON CONFLICT DO NOTHING` (two concurrent dispatches
of the identical command + idempotency key produce exactly one `workflow_events` row, with the
loser transparently returning the winner's cached `CommandResult`); (4) `WorkflowLockManager`'s
fence-token compare-and-swap (exactly one of two concurrent `acquire()` calls for the same lock
resource wins, and the fence strictly increases across a release/re-acquire cycle).

**Issue #57** adds a third suite in this tier, `packages/api/src/route-idempotency.postgres.test.ts`,
covering the route-level (`packages/api/src/route-idempotency.ts`) claim-first idempotency
against a real PostgreSQL `idempotency_keys` table: a claim → fulfill → reclaim round-trip through
a live `result JSONB` column (proving `parseJsonField()`'s auto-parsed-object handling actually
works against Postgres, not just a mocked query shape — the existing
`route-idempotency.test.ts` unit tests only mock this); a release-then-retry re-claim; and a real
concurrent-claim race (two `Promise.all`-driven claims for the same key) resolving to exactly one
`owned` outcome, the other `in-progress`. Reverting `claimRouteIdempotencyKey`'s `parseJsonField()`
call back to a bare `JSON.parse()` reproduces a real `TypeError` in the round-trip test.

#### SQLite test teardown — do not call `db.close()`

Never call `db.close()` in Vitest tests or scenario runner code. `better-sqlite3` registers native
GC finalizers for `Database` and `Statement` objects; explicit `db.close()` finalizes all
statements, causing a double-free SIGSEGV when V8's GC later runs the `Statement` finalizer.
The `vitest.config.ts` `pool: 'forks'` setting bypasses finalizers via `process.exit()` on
test-file completion. Let GC handle teardown naturally.
