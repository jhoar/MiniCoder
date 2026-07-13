# MiniCoder User Manual

> **Status: non-authoritative summary.** This manual is a practical, user-facing companion to the
> canonical specification under [`docs/`](docs/). Per the repo's own precedence rule, if anything
> here disagrees with a `docs/` file, the `docs/` file wins. Where this manual states an exact env
> var name, flag, or default, it was verified against the source in `packages/*/src`.

This guide covers three things:

1. [Getting started](#1-getting-started) — install, configure, and run MiniCoder locally.
2. [End-to-end walkthrough](#2-end-to-end-walkthrough) — take a specification from ingestion to a
   merged, documented project.
3. [Command reference](#3-command-reference) — every `minicoder` CLI command, grouped, with flags
   and what each one actually does.

If you just want the command list, jump to the [quick reference table](#quick-reference-table).

---

## 1. Getting Started

### 1.1 Prerequisites

- Node.js + [pnpm](https://pnpm.io) (`corepack enable` is the easiest way to get `pnpm` on `PATH`
  — every root script shells out to `pnpm -r ...`/`pnpm --filter ...`).
- Docker + Docker Compose, only if you want automated execution (Trigger.dev + the coder sandbox).
  You can do everything through Phase 6 (planning/backlog) without Docker.
- An OpenAI-compatible LLM endpoint (or a mock adapter for testing) if you want real Coder/
  Reviewer/Planner/Arbiter/Documentation agent runs instead of the deterministic test mocks.

### 1.2 Install and build

```bash
pnpm install
pnpm build          # pnpm -r build, in dependency order
```

### 1.3 Set up the database

MiniCoder runs on SQLite (local/single-node) or PostgreSQL (hosted/team) behind one persistence
abstraction — pick one via `DB_DIALECT`.

| Env var       | Purpose                                | Required?                                   |
| ------------- | --------------------------------------- | -------------------------------------------- |
| `DB_DIALECT`  | `sqlite` (default) or `postgres`        | Optional                                     |
| `DB_PATH`     | SQLite file path                        | Optional, defaults to `./minicoder.db`       |
| `DB_URL`      | PostgreSQL connection string            | Required only when `DB_DIALECT=postgres`     |

```bash
# SQLite (default) — creates ./minicoder.db
minicoder db migrate
minicoder db status
minicoder db validate
```

For PostgreSQL:

```bash
export DB_DIALECT=postgres
export DB_URL=postgres://user:pass@localhost:5432/minicoder
minicoder db migrate
```

To explore the system without wiring up real GitHub/LLM credentials, seed a fixture (SQLite only,
and only in a non-production environment):

```bash
minicoder db seed --fixture planning-review-merge --env development
```

### 1.4 Configure the Orchestrator API

The Orchestrator API (`packages/api`, Fastify) is the one network-facing surface. The CLI's own
`state`/`plan import-backlog`/`human`/`merge` subcommands talk to the database directly; everything
else (the Ink Text UI, the Web UI, and any external caller) talks to this API over HTTP with a
static API key.

```bash
export MINICODER_API_KEYS='[
  {"key":"dev-admin-key","id":"you","role":"admin","actorKind":"human","displayName":"You"}
]'
```

`MINICODER_API_KEYS` is a JSON array; each entry is:

```ts
{
  key: string;          // the bearer-token secret itself
  id: string;            // an identifier for this credential (shown in audit trails)
  role: 'viewer' | 'operator' | 'approver' | 'admin';
  actorKind: 'human' | 'system';
  displayName?: string;
}
```

Only the SHA-256 hash of each `key` is kept in memory — nothing raw is logged. Role gives you:
`viewer` (read-only), `operator` (non-guarded write actions), `approver`/`admin` (plan activation,
budget override, disagreement resolution, merge-if-ready, design-doc approval, and other guarded
actions).

If you'll also receive real GitHub webhooks through the API, set:

```bash
export GITHUB_WEBHOOK_SECRET=<your webhook secret>
export GITHUB_WEBHOOK_SECRET_PREVIOUS=<optional, for secret rotation>
```

Start it:

```bash
minicoder api serve --port 4000
```

### 1.5 Configure the CLI/Web clients

The Ink Text UI (`minicoder status`, `minicoder plan`, etc.) and the Next.js Web UI both talk to
the Orchestrator API over HTTP only:

```bash
export MINICODER_API_URL=http://localhost:4000   # TUI defaults to this if unset; Web UI requires it explicitly
export MINICODER_API_KEY=dev-admin-key            # the raw key value from one MINICODER_API_KEYS entry
```

The Web UI (`packages/web`) keeps this credential server-side only — nothing is shipped to the
browser. Because every visitor to a deployed Web UI instance shares that one key's identity, only
deploy it behind a trusted/internal network boundary (see `docs/07-security-and-secrets.md` §4).

### 1.6 Configure GitHub integration

Required for real PR creation/review/merge (as opposed to `minicoder github simulate-*` dev
fixtures):

```bash
export GITHUB_TOKEN=<GitHub App installation token or PAT>
```

Used by every task that talks to GitHub: `run-coder`, `run-review`, `run-merge-gate`,
`github-reconciliation`, `minicoder merge merge-if-ready`/`finalize-if-github-merged`,
`minicoder state doctor --check-github`.

### 1.7 Configure the LLM provider (Coder/Reviewer/Planner/Arbiter/Documentation)

All five agent roles' default (reference) adapters share one OpenAI-compatible endpoint
configuration — there's no separate env-var family per role:

```bash
export CODE_GEN_BASE_URL=https://api.openai.com/v1
export CODE_GEN_API_KEY=<your key>
export CODE_GEN_MODEL=gpt-4o-mini
```

Optional pricing overrides (used for cost tracking / budget gates — sensible defaults are baked
in if you skip these):

```bash
export CODE_GEN_PRICE_PER_1K_INPUT_TOKENS=0.00015
export CODE_GEN_PRICE_PER_1K_OUTPUT_TOKENS=0.0006
export DOCUMENTATION_PRICE_PER_1K_INPUT_TOKENS=0.00015
export DOCUMENTATION_PRICE_PER_1K_OUTPUT_TOKENS=0.0006
```

If you don't set `CODE_GEN_*`, every task that needs a real adapter and has no injected test mock
will fail fast with an actionable error — this is intentional (fail loud, not silently run against
nothing). Test scenarios inject `MockCoderAdapter`/`MockReviewerAdapter`/etc. and never hit these
vars.

### 1.8 Start Trigger.dev (Workflow Layer)

Automated execution — the actual coding/review/merge loop — runs as durable Trigger.dev tasks.
Skip this section if you only want to explore planning/backlog generation, or if you're driving
transitions manually via CLI/API for a demo.

Default backend is a 9-service self-hosted Docker Compose stack:

```bash
export TRIGGER_MAGIC_LINK_SECRET=$(openssl rand -hex 32)
export TRIGGER_SESSION_SECRET=$(openssl rand -hex 32)
export TRIGGER_ENCRYPTION_KEY=$(openssl rand -hex 32)
export TRIGGER_MANAGED_WORKER_SECRET=$(openssl rand -hex 32)
export TRIGGERDEV_WEBHOOK_SECRET=$(openssl rand -hex 32)
export MINIO_ROOT_USER=minio
export MINIO_ROOT_PASSWORD=$(openssl rand -hex 16)

docker compose -f infra/docker-compose.triggerdev.yml up -d
docker compose -f infra/docker-compose.triggerdev.yml ps
```

The webapp UI comes up at `http://localhost:3040`. Deploy your tasks with the pinned CLI (never
`@latest`):

```bash
pnpm --filter @minicoder/triggerdev build
cd packages/triggerdev
TRIGGER_PROJECT_REF=<your-ref> npx trigger.dev@4.4.6 deploy --env staging --api-url "$TRIGGERDEV_API_URL"
```

Then point `minicoder api serve` at the runtime API so its task-enqueue routes
(`request-coder-run`, `request-review`, `request-fixes`, `recompute-merge-gate`,
`request-design-doc`) actually work:

```bash
export TRIGGER_SECRET_KEY=<runtime secret key>
export TRIGGER_API_URL=http://localhost:3040   # must be http(s); never left to default to Cloud
```

Full resource-sizing table, image-digest pinning, and troubleshooting live in
`docs/04-testing-validation-state-lifecycle.md` §11 (the "Trigger.dev (Self-Host) Operations
Runbook").

### 1.9 Start the coder sandbox (optional, real coding runs only)

The Coder adapter executes LLM-generated code inside an ephemeral, non-root, network-isolated
Docker container (default-deny egress via a `tinyproxy` allow-list proxy):

```bash
docker build -t minicoder/coder-sandbox:latest infra/docker/coder-sandbox
docker compose -f infra/docker-compose.coder-sandbox.yml up -d
```

```bash
export CODER_SANDBOX_IMAGE=minicoder/coder-sandbox:latest   # default shown
export CODER_SANDBOX_NETWORK=minicoder-coder-sandbox        # default shown
export CODER_SANDBOX_DOCKER_HOST=coder-sandbox-docker-proxy:2375   # optional
export CODER_SANDBOX_HTTPS_PROXY=coder-sandbox-egress-proxy:8888   # optional
```

> **Note:** at the time of writing, this compose stack is real, reviewed infrastructure that has
> not been exercised against a live Docker daemon in this repository's own CI — treat it as needing
> a live-daemon verification pass in your environment, not as untested/aspirational.

### 1.10 Observability export (optional)

If you run a real OpenTelemetry Logs collector, point the exporter at it:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://your-collector:4318/v1/logs
```

Then invoke the one-shot export on whatever schedule you like (cron, k8s CronJob — MiniCoder
deliberately does not run this automatically, so there's no always-on network dependency):

```bash
minicoder observability export-otel
```

Leaving `OTEL_EXPORTER_OTLP_ENDPOINT` unset makes this command (and the underlying exporter) a
complete no-op.

---

## 2. End-to-End Walkthrough

This walks a specification from raw text through a fully merged, documented project. Every step
shows both the API call (works against any deployment) and, where one exists, the equivalent CLI
command.

All examples assume `MINICODER_API_URL`/`MINICODER_API_KEY` are set (§1.5) and the key's role is
at least `operator` (some steps require `approver`/`admin` — noted inline).

### Step 1 — Create a project and ingest a specification

There's no dedicated "create project" CLI command; a project is created implicitly by the first
`ingest-specification` command, which also kicks off the whole pipeline.

```bash
curl -X POST "$MINICODER_API_URL/commands/ingest-specification" \
  -H "Authorization: Bearer $MINICODER_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
        "content": "Build a URL shortener with a REST API and click analytics...",
        "contentType": "text/plain",
        "actorId": "you",
        "actorRole": "operator"
      }'
```

This dispatches the `ingest-specification` Trigger.dev task (if you have a worker running) or the
underlying command directly. Watch progress with:

```bash
minicoder status --project <projectId>
```

### Step 2 — Planning readiness assessment

The Planner adapter assesses whether the specification has enough information to plan from. This
step requires a live `PlannerAgentAdapter` instance, so it is **not** reachable via generic
`/commands/...` dispatch — it only runs as the `planning-readiness-assessment` Trigger.dev task
(triggered automatically after ingestion, or manually if you're driving Trigger.dev yourself).

```bash
minicoder status --project <projectId>   # shows readiness state
```

If the assessment finds gaps, it opens a **clarification session** (`clarification_required`);
if there's enough information (with or without stated assumptions), it proceeds straight to
`clarification_not_required` → `clarification_complete`.

### Step 3 — Clarification (only if required)

```bash
minicoder clarification --project <projectId>
```

Answer each open question via:

```bash
curl -X POST "$MINICODER_API_URL/commands/record-clarification-answer" \
  -H "Authorization: Bearer $MINICODER_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"questionId":"<id>","answerText":"...","actorId":"you","actorRole":"operator"}'
```

then complete the round:

```bash
curl -X POST "$MINICODER_API_URL/commands/complete-clarification" ...
```

There's a hard circuit breaker: 3 rounds max, each with a per-round timeout. Exceeding either
produces `clarification_blocked` → `human_required` — a human must intervene (see
[`minicoder human ...`](#human-escalation)) to unstick it.

### Step 4 — Generate the implementation plan and feature backlog

Once clarification is complete, generate the plan and backlog (system-actor operations, typically
run by the `generate-implementation-plan`/`generate-feature-backlog` Trigger.dev tasks):

```bash
minicoder plan --project <projectId>   # view current plan + readiness state
```

### Step 5 — Validate and approve the backlog

```bash
curl -X POST "$MINICODER_API_URL/commands/validate-backlog" ...
```

A plan can only be submitted for approval once its current backlog version has passed validation.
Approval requires `approver`/`admin`:

```bash
curl -X POST "$MINICODER_API_URL/commands/submit-plan-for-approval" ...
curl -X POST "$MINICODER_API_URL/commands/approve-plan" \
  -H "Authorization: Bearer $APPROVER_KEY" ...
```

### Step 6 — Activate the backlog

Also `approver`/`admin`-gated. This inserts one `feature_runs` row per executable feature request,
each starting at `approved_pending_execution`:

```bash
curl -X POST "$MINICODER_API_URL/commands/activate-plan" \
  -H "Authorization: Bearer $APPROVER_KEY" ...
```

```bash
minicoder features --project <projectId>
```

### Step 7 — Automated execution takes over

From here, if Trigger.dev is running (§1.8) with real Coder/Reviewer adapters configured (§1.7)
and `GITHUB_TOKEN` set (§1.6), MiniCoder runs the rest on its own, one feature at a time:

```
approved_pending_execution → selected → coding → code_pushed → pr_opened → ci_running
→ under_review → (changes_requested → fixing → code_pushed → ci_running → under_review)*
→ approved_by_policy → merge_ready → merged
```

Watch it happen:

```bash
minicoder active --project <projectId>          # the currently-executing feature
minicoder runs --project <projectId>            # every agent run
minicoder runs --timeline <featureRunId>         # merged event/run/finding/cost timeline for one feature
minicoder findings --feature-run <featureRunId>  # reviewer/CI findings
minicoder costs --project <projectId> --report   # budget report
```

If automation needs to pause (a budget breach, an operator pause, a disagreement that escalates,
or a fix-attempt/CI-failure limit), the feature run lands at `human_required`, `blocked`,
`paused_budget_exceeded`, or `waiting_for_budget_approval`. Check for these with:

```bash
minicoder features --project <projectId> --human-required
```

and resolve them (all `approver`-gated) with `minicoder human ...` (see the
[reference](#human-escalation)).

If you're not running Trigger.dev, you can still drive individual transitions manually via the
enqueue routes (`request-coder-run`, `request-review`, `request-fixes`, `recompute-merge-gate`)
or `minicoder merge merge-if-ready` once a feature reaches `merge_ready`.

### Step 8 — Automation control

Pause/resume the whole project's automated execution at any time:

```bash
minicoder pause --project <projectId> --yes
minicoder resume --project <projectId> --yes
```

### Step 9 — Mark implementation complete and validate acceptance

Once every feature is `merged` or deliberately `skipped`, and no feature is stuck at
`human_required`/`blocked`, mark the project's implementation phase done. This requires
attestation that CI-only checks (full test suite, migrations, build, lint, security scan — things
a DB-only check can't itself verify) already passed out-of-band:

```bash
minicoder project validate-acceptance --project <projectId>   # pre-flight, read-only
minicoder project mark-implementation-complete --project <projectId> \
  --evidence "CI run https://github.com/org/repo/actions/runs/123 green" --yes
```

### Step 10 — Generate and approve the final design document

```bash
minicoder design-doc generate --project <projectId> --yes
minicoder design-doc --project <projectId>              # view sections once generated
```

If a section needs rework:

```bash
minicoder design-doc request-revision --project <projectId> --document <docId> --yes \
  --notes "Expand the data-design section"
minicoder design-doc regenerate --project <projectId> --yes
```

Once satisfied (`approver`/`admin`):

```bash
minicoder design-doc approve --project <projectId> --document <docId> --yes
```

### Step 11 — Complete the project

```bash
minicoder project complete --project <projectId> --yes
```

The project is now at the terminal `project_complete` state, with a full audit trail —
`workflow_events`, `agent_runs`, `review_findings`, `cost_records`, `human_approvals`,
`merge_gate_evaluations` — and a generated `final-design-document.md` artifact export.

---

## 3. Command Reference

### Quick reference table

| Command group                  | Purpose                                                          | Talks to    |
| ------------------------------- | ----------------------------------------------------------------- | ----------- |
| `minicoder db ...`               | Database lifecycle: migrate, seed, snapshot, reset                | DB directly |
| `minicoder trigger ...`          | Trigger.dev deploy/validate (management-API subcommands are stubs) | DB / Trigger.dev |
| `minicoder state ...`            | Inspect, validate, reconcile, doctor, repair workflow state       | DB directly |
| `minicoder github serve`         | Run the GitHub webhook receiver                                   | DB directly |
| `minicoder github simulate-*`    | Dev/test-only: inject fake GitHub inbox events                    | DB directly |
| `minicoder human ...`            | Resolve human-escalation dispositions                             | DB directly |
| `minicoder merge ...`            | Merge-if-ready / finalize-after-manual-merge                      | DB directly |
| `minicoder plan import-backlog`  | Import a `backlog.md` artifact                                    | DB directly |
| `minicoder api serve`            | Run the Orchestrator API (Fastify)                                | DB, GitHub, Trigger.dev |
| `minicoder status/plan/features/...` | Ink Text UI read/write views                                  | Orchestrator API (HTTP) |
| `minicoder project ...`          | Project-lifecycle / acceptance commands                           | Orchestrator API (HTTP) |
| `minicoder design-doc ...`       | Final design document generation/approval                          | Orchestrator API (HTTP) |
| `minicoder observability export-otel` | One-shot OTel Logs export                                     | DB + OTLP collector |
| `minicoder test ...`             | Run test tiers (unit / integration / system scenarios)            | —           |

Commands under **"Orchestrator API (HTTP)"** need `MINICODER_API_URL`/`MINICODER_API_KEY` (§1.5).
Commands under **"DB directly"** need `DB_DIALECT`/`DB_PATH`/`DB_URL` (§1.3) and, for the
GitHub/Trigger.dev/merge ones, `GITHUB_TOKEN`.

---

### Database lifecycle (`minicoder db ...`)

All operate directly against the configured database (SQLite by default).

| Command | Flags | What it does |
| --- | --- | --- |
| `minicoder db migrate` | — | Applies every pending migration. |
| `minicoder db rollback` | — | Rolls back the most recent migration. |
| `minicoder db status` | — | Prints `✓ applied` / `○ pending` for each migration. |
| `minicoder db validate` | — | Confirms every expected table exists (schema drift check). |
| `minicoder db diff` | — | Lists pending migrations without applying them. |
| `minicoder db reset` | `--dry-run` \| `--apply --yes --confirmation <token>`, `--env <environment>` (must be `development`/`test`/`ci`), `--actor <name>` (required), `--backup-verified` \| `--backup-exempt "<reason>"` (required), `--disposable-db`, `--force-host` | Fully wipes and re-migrates the database. Two-step, guarded: `--dry-run` previews and prints a 5-minute single-use confirmation token; `--apply` executes. Hard-rejects if `APP_ENV`/`NODE_ENV` is `production`, regardless of `--env`. PostgreSQL targets must be in `MINICODER_ALLOWED_RESET_HOSTS` (default `localhost`/`127.0.0.1`/`::1`) or pass `--force-host`. |
| `minicoder db seed` | `--fixture <name>` (default `planning-review-merge`), `--env <environment>`, `--project <id>` | Inserts fixture data. SQLite only. Dev/test/ci only (`guardEnv()` — hard production reject). |
| `minicoder db snapshot` | `--output <path>` (required, must not already exist) | Copies the SQLite file to `<path>`. |
| `minicoder db restore` | `--input <path>` (required), `--env <environment>`, `--yes` (required) | Overwrites the live SQLite file from a snapshot. Dev/test/ci only. |

Default SQLite path is `./minicoder.db` (override with `DB_PATH`). Migration files live under
`packages/migrations/migrations/`.

### Trigger.dev lifecycle (`minicoder trigger ...`)

`deploy`/`validate`/`reconcile` are functional; `list-runs`/`inspect-run`/`cancel-run`/
`replay-run`/`drain-queue`/`reset-dev` are stubs reserved for a future Trigger.dev
_management_-API client (distinct from the runtime `tasks.trigger()` API `minicoder api serve`
already uses for its enqueue routes). Use the raw `npx trigger.dev@4.4.6 deploy ...` command
(§1.8) for real deploys today.

### Workflow / state lifecycle (`minicoder state ...`)

| Command | What it does |
| --- | --- |
| `minicoder state inspect` | Prints current state for a project/feature run. |
| `minicoder state validate` | Checks state-machine invariants against the DB. |
| `minicoder state reconcile --project <id>` | Clears stale workflow locks scoped to that project only. |
| `minicoder state reconcile --all` | Clears stale locks globally **and** marks stuck `outbox_events`/`inbox_events` as failed. Requires explicit `--all` — global mutation is opt-in. |
| `minicoder state doctor` | Runs the always-on, pure-DB health checks (stuck queues, orphaned pushes with no PR, secret-leak scan, project-acceptance-violated, etc.). |
| `minicoder state doctor --check-github` | Adds the one GitHub-credential-requiring check (PR-discovery divergence). Needs `GITHUB_TOKEN`. |
| `minicoder state export-diagnostics` | Dumps a full diagnostics snapshot (all doctor checks + global operational state) as JSON. |
| `minicoder state repair --project <id> --dry-run` | Previews a repair; prints a single-use, 5-minute confirmation token bound to that project. |
| `minicoder state repair --project <id> --apply --confirmation <token>` | Executes the previewed repair. `--project` is mandatory for both steps — there is no global/unscoped repair. |

### GitHub integration

| Command | What it does |
| --- | --- |
| `minicoder github serve` | Runs the standalone GitHub webhook receiver (HMAC-verified via `GITHUB_WEBHOOK_SECRET`). Runs in any environment, including production — not env-guarded. |
| `minicoder github simulate-pr-opened` / `simulate-pr-closed` / `simulate-pr-merged` / `simulate-check-passed` / `simulate-check-failed` / `simulate-review-approved` / `simulate-review-changes-requested` / `simulate-branch-protection-ok` | Inject a fake GitHub inbox event for local testing, without a real webhook. Dev/test/ci only (`guardEnv()`). |

### Human escalation (`minicoder human ...`)

All require `--feature-run <id> --project <id> --actor <id>` and dispatch a real state-machine
command directly against the DB (not the HTTP API). All are `approver`-level actions.

| Command | Transition | Extra flags |
| --- | --- | --- |
| `minicoder human resolve-disagreement` | `human_required → changes_requested` | `--resolution <text>`, optional `--disagreement <id>` |
| `minicoder human resume` | `human_required → under_review` (no fix needed) | `--notes <text>`, optional `--disagreement <id>` |
| `minicoder human retry` | `human_required → selected` | `--notes <text>` |
| `minicoder human skip` | `human_required → skipped` (terminal) | `--notes <text>` |
| `minicoder human block` | `human_required → blocked` | `--notes <text>` |
| `minicoder human unblock` | `blocked → approved_pending_execution` | `--notes <text>` |

### Merge Gate (`minicoder merge ...`)

Also dispatches directly against the DB, plus a real GitHub API call.

| Command | What it does |
| --- | --- |
| `minicoder merge merge-if-ready --feature-run <id> --project <id> --actor <id> [--actor-role approver] [--merge-method squash\|merge\|rebase]` | Re-evaluates the merge gate; if it passes, merges the PR on GitHub and records the outcome. |
| `minicoder merge finalize-if-github-merged --feature-run <id> --project <id>` | Recovery command: re-verifies against GitHub that a PR was actually merged, then records it — for the rare case where a merge succeeded on GitHub but local recording failed. |

### Plan/backlog artifact import

| Command | What it does |
| --- | --- |
| `minicoder plan import-backlog <file> --project <id> --plan <id> --actor <id> [--actor-role approver] [--dry-run]` | Parses a `backlog.md` export and imports it as the plan's feature backlog. `--dry-run` previews without writing. |

### Orchestrator API server

| Command | Flags | What it does |
| --- | --- | --- |
| `minicoder api serve` | `--port <number>`, `--host <host>` | Starts the Fastify Orchestrator API. Requires `MINICODER_API_KEYS`, `GITHUB_WEBHOOK_SECRET`. Uses `TRIGGER_SECRET_KEY`/`TRIGGER_API_URL` if set (enables the task-enqueue routes); otherwise those routes fail with an actionable error only when called. |

### Ink Text UI (`minicoder status/plan/.../pause/resume`)

All of these are one-shot fetch-render-exit commands against the Orchestrator API — pass
`--json` on any of them to get the raw API response instead of a formatted table.

| Command | What it shows/does | Notes |
| --- | --- | --- |
| `minicoder status --project <id>` | Project + workflow-state overview, including a state-health section (needs operator+ key for the doctor summary) | |
| `minicoder plan --project <id>` | Current plan + planning-readiness state | (bare `plan`, no subcommand — a hidden default subcommand under the hood) |
| `minicoder clarification --project <id> [--session <id>]` | Open clarification questions and answers | |
| `minicoder features --project <id> [--cursor <c>] [--limit <n>]` | Feature-request/run listing | |
| `minicoder features --project <id> --human-required` | Only feature runs currently at `human_required` | Uses a dedicated read model, not a client-side filter |
| `minicoder active --project <id>` | The project's currently-executing feature run | |
| `minicoder runs [--project <id>] [--feature-run <id>] [--cursor <c>] [--limit <n>]` | Agent-run listing | |
| `minicoder runs --timeline <featureRunId>` | Merged chronological timeline (events, agent runs, findings, PR activity, cost, approvals) for one feature run | |
| `minicoder findings --feature-run <id> [--cursor <c>] [--limit <n>]` | Review findings for a feature run | |
| `minicoder disagreements [--feature-run <id>] [--state <state>] [--cursor <c>] [--limit <n>]` | Coder/reviewer disagreement records | |
| `minicoder costs --project <id>` | Raw `cost_records` listing | |
| `minicoder costs --project <id> --report [--window-days <n>]` | Aggregated budget report (by scope/feature/provider/model/role) | |
| `minicoder artifacts --project <id> [--cursor <c>] [--limit <n>]` | Exported artifacts (plan/backlog/design-doc exports) | |
| `minicoder adapters [--adapter <id>]` | Registered agent adapters and their capabilities | |
| `minicoder design-doc --project <id> [--document <id>]` | Design document sections (read-only view) | bare form; see below for action subcommands |
| `minicoder pause --project <id> --yes` | Pauses automated execution for the project | `approver`+ |
| `minicoder resume --project <id> --yes` | Resumes automated execution | `approver`+ |

### Final Design Document Generator

| Command | What it does |
| --- | --- |
| `minicoder project mark-implementation-complete --project <id> --evidence <text> --yes` | Transitions `active → implementation_complete`. `--evidence` is a required attestation (e.g. a CI run URL) that out-of-band checks (full test suite, build, lint, security scan) already passed — stored as an audit record. |
| `minicoder project validate-acceptance --project <id>` | Read-only pre-flight: runs the DB-knowable subset of Project Acceptance Validation without transitioning anything. |
| `minicoder project complete --project <id> --yes` | Transitions `design_document_approved → project_complete`. |
| `minicoder design-doc generate --project <id> --yes` | Generates a fresh design document (all 13 sections) via the Documentation adapter. |
| `minicoder design-doc regenerate --project <id> --yes` | Same as `generate`, for a revision cycle — creates a new document/export, doesn't edit the old one in place. |
| `minicoder design-doc request-revision --project <id> --document <id> --yes [--notes <text>]` | `design_document_ready_for_review → design_document_revision_requested`. |
| `minicoder design-doc approve --project <id> --document <id> --yes [--notes <text>]` | `design_document_ready_for_review → design_document_approved`. `approver`+. |
| `minicoder design-doc request-run --project <id> --documentation-adapter <name>` | Manually (re-)triggers the `run-design-doc` Trigger.dev task. |

### Observability

| Command | Flags | What it does |
| --- | --- | --- |
| `minicoder observability export-otel` | `--cursor-id <id>` (default `workflow_events_otlp`), `--limit <n>` | One-shot export of `workflow_events` to an OTLP/HTTP Logs collector. No-op if `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. Meant to be invoked by your own external scheduler (cron/CronJob) — MiniCoder never runs this automatically. |

### Testing

| Command | What it runs |
| --- | --- |
| `minicoder test unit` | Every `*.test.ts` except integration tests and `packages/testing/src/**` scenario fixtures. |
| `minicoder test integration` | Only `*.integration.test.ts` (needs a real DB). |
| `minicoder test system` | The programmatic scenario runner (`runAllScenarios()`). |
| `minicoder test scenario <name>` | One named scenario — see `docs/04-testing-validation-state-lifecycle.md` for the full list (e.g. `planning-basic`, `review-loop`, `merge-gate`, `disagreement-arbiter`, `final-design-document`). |

---

## Appendix: environment variable reference

Grouped by subsystem. "Required" means the process fails fast with an actionable error if unset
when that subsystem's code path is actually exercised — not necessarily at process startup.

**Database**
`DB_DIALECT` (optional, default `sqlite`) · `DB_PATH` (optional, default `./minicoder.db`) ·
`DB_URL` (required if `DB_DIALECT=postgres`) · `MINICODER_ALLOWED_RESET_HOSTS` (optional) ·
`APP_ENV` / `NODE_ENV` (optional, gates destructive/dev-only commands) ·
`MANAGED_SECRETS_URL` / `MANAGED_SECRETS_API_KEY` (required only if using the managed secrets
backend)

**GitHub**
`GITHUB_TOKEN` (required for any real GitHub call) · `GITHUB_WEBHOOK_SECRET` (required to start
`api serve`/`github serve`) · `GITHUB_WEBHOOK_SECRET_PREVIOUS` (optional, rotation)

**Trigger.dev**
`TRIGGER_SECRET_KEY` / `TRIGGER_API_URL` (both required for `api serve`'s task-enqueue routes;
`TRIGGER_API_URL` must be a real `http(s)://` URL — it is never left to default to Trigger.dev
Cloud) · `TRIGGERDEV_BACKEND` (optional, default `self-host-single-node`) ·
`TRIGGERDEV_API_URL` / `TRIGGERDEV_API_KEY` / `TRIGGERDEV_WEBHOOK_SECRET` (self-host backend
config) · `TRIGGER_MAGIC_LINK_SECRET` / `TRIGGER_SESSION_SECRET` / `TRIGGER_ENCRYPTION_KEY` /
`TRIGGER_MANAGED_WORKER_SECRET` / `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` (required by the
Docker Compose stack) · `DEPLOY_REGISTRY_HOST` / `DOCKER_REGISTRY_URL` (optional registry
overrides) · `TRIGGER_PROJECT_REF` (required for `trigger.dev deploy`)

**LLM provider (Coder/Reviewer/Planner/Arbiter shared)**
`CODE_GEN_BASE_URL` / `CODE_GEN_API_KEY` / `CODE_GEN_MODEL` (required for any real adapter run) ·
`CODE_GEN_PROVIDER_NAME` (optional, default `openai-compatible`) ·
`CODE_GEN_PRICE_PER_1K_INPUT_TOKENS` / `CODE_GEN_PRICE_PER_1K_OUTPUT_TOKENS` (optional) ·
`CODER_PROMPT_TEMPLATE_VERSION` (optional)

**Documentation adapter (its own pricing, same endpoint)**
`DOCUMENTATION_PRICE_PER_1K_INPUT_TOKENS` / `DOCUMENTATION_PRICE_PER_1K_OUTPUT_TOKENS` (optional) ·
`DOCUMENTATION_PROMPT_TEMPLATE_VERSION` (optional, default `documentation-v1`)

**Coder sandbox**
`CODER_SANDBOX_IMAGE` (optional, default `minicoder/coder-sandbox:latest`) ·
`CODER_SANDBOX_NETWORK` (optional, default `minicoder-coder-sandbox`) ·
`CODER_SANDBOX_DOCKER_HOST` / `CODER_SANDBOX_HTTPS_PROXY` (optional) ·
`CODE_GEN_ALLOWED_HOST` (optional, egress-proxy allow-list only — not read by any TypeScript code)

**Orchestrator API auth**
`MINICODER_API_KEYS` (required to start `api serve`; JSON array — see §1.4)

**Client (TUI / Web UI)**
`MINICODER_API_KEY` (required) · `MINICODER_API_URL` (optional for TUI, default
`http://localhost:4000`; required, no default, for the Web UI)

**Observability**
`OTEL_EXPORTER_OTLP_ENDPOINT` (optional — unset means `export-otel` is a complete no-op)

**Merge gate policy**
`MERGE_GATE_BLOCKING_LABELS` (optional, comma-separated, default `do-not-merge,wip,blocked`)
