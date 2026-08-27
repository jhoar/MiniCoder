# MiniCoder User Manual

> **Non-authoritative.** This is a user-facing guide, not a specification. If anything here
> disagrees with a file under [`docs/`](docs/), the `docs/` file wins — see that directory for the
> canonical state machines, command matrices, and API contract. Terminology (state names, roles,
> command names) is used verbatim from [`docs/00-glossary-and-terms.md`](docs/00-glossary-and-terms.md).

## What MiniCoder does, in one paragraph

You give MiniCoder a specification. It clarifies anything ambiguous by asking you questions, turns
the result into an approved backlog of features, and then — one feature at a time — has an AI
coder write the code, push a branch, open a pull request, wait for CI, have an AI reviewer review
it, fix what needs fixing, and merge it once your policy gate is satisfied. When every feature is
merged, it drafts a final design document for you to approve. You interact with it either through
a terminal (`minicoder ...` commands) or a browser (the Web UI); at a handful of decision points —
approving the plan, resolving a disagreement between the coder and reviewer, approving a merge, or
signing off on the final design doc — it stops and waits for a human.

---

## Table of contents

1. [Quick summary of every command](#1-quick-summary-of-every-command)
2. [Before you start: concepts you need](#2-before-you-start-concepts-you-need)
3. [Installing and standing up a deployment](#3-installing-and-standing-up-a-deployment)
4. [End-to-end walkthrough: building a project with MiniCoder](#4-end-to-end-walkthrough-building-a-project-with-minicoder)
5. [Complete command reference](#5-complete-command-reference)
6. [Troubleshooting and recovery](#6-troubleshooting-and-recovery)
7. [Glossary quick-reference](#7-glossary-quick-reference)

---

## 1. Quick summary of every command

| Command                                                                            | What it's for                                                                          |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `minicoder db migrate/rollback/status/validate/diff`                               | Manage the database schema.                                                            |
| `minicoder db reset`                                                               | Wipe and re-migrate the database (guarded, destructive).                               |
| `minicoder db seed/snapshot/restore`                                               | Dev/test fixture and backup helpers.                                                   |
| `minicoder tasks worker`                                                           | Run the background worker that executes queued automation tasks.                       |
| `minicoder tasks drain`                                                            | Wait for the task queue to empty (CI/scripts).                                         |
| `minicoder trigger list-runs/inspect-run/cancel-run/replay-run/reconcile/validate` | Inspect and manage individual task-queue runs.                                         |
| `minicoder github serve`                                                           | Run the GitHub webhook receiver.                                                       |
| `minicoder github simulate-*`                                                      | Fake a GitHub event for local testing (dev/test only).                                 |
| `minicoder api serve`                                                              | Run the Orchestrator API — the backend the UIs and most CLI read commands talk to.     |
| `minicoder status`                                                                 | Project dashboard: state, automation, workflow health.                                 |
| `minicoder plan`                                                                   | View the implementation plan and readiness.                                            |
| `minicoder plan import-backlog <file>`                                             | Import a hand-written `backlog.md`.                                                    |
| `minicoder clarification`                                                          | View clarification questions/answers.                                                  |
| `minicoder features`                                                               | List the feature backlog, or (`--human-required`) items awaiting a human.              |
| `minicoder active`                                                                 | Show the one feature currently being worked on and its PR/CI status.                   |
| `minicoder runs`                                                                   | List agent runs, or (`--timeline`) a merged history for one feature.                   |
| `minicoder findings`                                                               | List review findings for a feature run.                                                |
| `minicoder disagreements`                                                          | List coder/reviewer disagreements.                                                     |
| `minicoder costs`                                                                  | List spend, or (`--report`) an aggregate budget breakdown.                             |
| `minicoder artifacts`                                                              | List generated artifacts (plan.md, backlog.md, final-design-document.md).              |
| `minicoder adapters`                                                               | List registered AI adapters (read-only).                                               |
| `minicoder design-doc`                                                             | View, generate, regenerate, request revision on, or approve the final design document. |
| `minicoder project`                                                                | Mark implementation complete, check acceptance validation, complete the project.       |
| `minicoder pause` / `minicoder resume`                                             | Stop/restart automated execution for a project.                                        |
| `minicoder human resolve-disagreement/resume/retry/skip/block/unblock`             | Disposition a feature stuck at `human_required` or `blocked`.                          |
| `minicoder merge merge-if-ready`                                                   | Approve and execute a merge (the human trigger for merging).                           |
| `minicoder merge finalize-if-github-merged`                                        | Recovery command if a merge succeeded on GitHub but wasn't recorded.                   |
| `minicoder spec ingest <file>`                                                     | Ingest a specification file.                                                           |
| `minicoder clarification answer`                                                   | Answer a clarification question.                                                       |
| `minicoder plan submit-for-approval/approve/activate`                              | Submit, approve, and activate the implementation plan.                                 |
| `minicoder budget approve-override`                                                | Approve a budget override for a paused project.                                        |
| `minicoder run coder/review/fixes/merge-gate`                                      | Enqueue an ad hoc coder run, reviewer run, fix re-review, or merge-gate recompute.     |
| `minicoder state inspect/validate/doctor/reconcile/export-diagnostics`             | Diagnose and repair workflow health.                                                   |
| `minicoder state repair`                                                           | Guarded, two-step repair of orphaned runs.                                             |
| `minicoder observability export-otel`                                              | Export workflow events to an OpenTelemetry collector.                                  |
| `minicoder test unit/integration/system/scenario`                                  | Run the automated test suites.                                                         |

Full details, every flag, and defaults are in [§5](#5-complete-command-reference).

---

## 2. Before you start: concepts you need

**A project** holds one specification, one implementation plan, one feature backlog, and (later)
one final design document.

**A feature request** (`FR-001`, `FR-002`, ...) is one backlog item. Each one goes through its own
execution lifecycle:

```
approved_pending_execution → selected → coding → code_pushed → pr_opened → ci_running
→ under_review → changes_requested → fixing → code_pushed → ci_running → under_review
→ approved_by_policy → merge_ready → merged
```

If something goes wrong at any point, the feature can land in `human_required` (needs a person to
decide what happens next) or `blocked` (waiting on something else, usually another feature). A
human can also `skip` a feature outright.

`blocked` does **not** clear itself once the dependency merges — there is no automatic caller for
that today. An operator must run `minicoder human unblock` once the upstream dependency is
`merged`; it re-checks the dependency and rejects if it still isn't.

**Automation** for a whole project can be `running`, `paused_by_operator` (you paused it), or
paused because a cost budget was hit (`paused_budget_exceeded` / `waiting_for_budget_approval`).
Only one feature is worked on at a time per project — this is deliberate, not a limitation.

**Roles.** Every action is gated by a role: `viewer` (read-only), `operator` (can trigger runs,
pause/resume, recompute the merge gate), `approver` (can approve plans, resolve disagreements,
merge, approve the design document), `admin` (all of the above, plus system-replay actions). Your
role comes from the API key you're using — see [§3](#3-installing-and-standing-up-a-deployment).

**Where MiniCoder is authoritative vs. GitHub.** MiniCoder's database is the source of truth for
plans, backlog, and workflow state. GitHub is the source of truth for the actual code, branches,
commits, PRs, reviews, and CI/merge status — MiniCoder watches GitHub via webhooks (with a
scheduled reconciliation pass as a fallback) and mirrors what it sees.

---

## 3. Installing and standing up a deployment

### 3.1 Prerequisites

- Node.js and `pnpm` on `PATH` (`corepack enable` if you haven't already).
- A database: SQLite for local/single-node use, PostgreSQL for a hosted/team deployment. Never put
  SQLite on a network filesystem.
- A GitHub repository and a token (`GITHUB_TOKEN`) with permission to push branches, open PRs, and
  merge — MiniCoder pushes real commits and opens real pull requests against it.
- An LLM provider endpoint for the coder/reviewer/planner/arbiter/documentation adapters
  (`CODE_GEN_BASE_URL`, `CODE_GEN_API_KEY`, `CODE_GEN_MODEL` — any OpenAI-compatible endpoint).

### 3.1.1 Generating `GITHUB_TOKEN` and `GITHUB_WEBHOOK_SECRET`

**`GITHUB_TOKEN`** — used by the coder/reviewer adapters (push branches, open PRs), `minicoder
merge ...` (merge, publish the `minicoder/review-gate` status check), `github-reconciliation`
(list/read PRs, checks, commit statuses), and `state doctor --check-scm` (formerly
`--check-github`, still supported as a deprecated alias) for a GitHub-provider repository. A
Gitea- or GitLab-provider repository instead needs `GITEA_TOKEN`/`GITLAB_TOKEN` (a Gitea
personal/organization access token, a GitLab personal/project access token) for the same
on-demand check.

Fine-grained personal access tokens are recommended over classic tokens (narrower blast radius if
leaked):

1. GitHub → Settings → Developer settings → **Personal access tokens → Fine-grained tokens** →
   **Generate new token**.
2. **Repository access**: "Only select repositories" → pick the repo MiniCoder will operate on.
3. **Permissions** → Repository permissions, grant exactly:
   - **Contents**: Read and write (push commits/branches)
   - **Pull requests**: Read and write (open, list, merge PRs)
   - **Commit statuses**: Read and write (publish/read the `minicoder/review-gate` check, read CI results)
   - **Metadata**: Read-only (auto-required)
4. Set an expiration and generate. Copy the token immediately — GitHub shows it once.
5. `export GITHUB_TOKEN=<the token>` (or set it in `.env`).

A classic PAT works too (Settings → Developer settings → Personal access tokens → Tokens
(classic)) — grant the single **`repo`** scope, which is a superset of everything above.

Either way, the identity behind the token (a user account, or a
[GitHub App](https://docs.github.com/en/apps) installation token if you've wired one up yourself —
MiniCoder's `GitHubClient` interface doesn't care which) needs at least **write** access to the
repository, since it merges PRs and pushes branches directly.

**`GITHUB_WEBHOOK_SECRET`** — this one you generate yourself; it's never obtained from GitHub. It's
an arbitrary shared secret both sides must agree on: MiniCoder verifies each webhook delivery's
`X-Hub-Signature-256` header (HMAC-SHA256 over the raw request body) against it.

1. Generate a strong random value:
   ```bash
   openssl rand -hex 32
   ```
2. `export GITHUB_WEBHOOK_SECRET=<that value>` (or set it in `.env`).
3. Register the _same_ value on the GitHub side: repository → **Settings → Webhooks → Add
   webhook**.
   - **Payload URL**: `https://<your-minicoder-host>/webhooks/github` (whichever process is
     receiving it — see 3.5's "pick one, not both" note for `api serve` vs `github serve`).
   - **Content type**: `application/json`.
   - **Secret**: paste the same value from step 1.
   - **Which events**: either "Send me everything," or, to match exactly what MiniCoder consumes,
     select individually: _Pull requests_, _Pull request reviews_, _Pull request review comments_,
     _Check runs_, _Check suites_, _Statuses_, _Pushes_.
   - Leave **Active** checked, then **Add webhook**.
4. Rotating later: set the new value as `GITHUB_WEBHOOK_SECRET` and the _old_ one as
   `GITHUB_WEBHOOK_SECRET_PREVIOUS` (both are accepted during the rotation window), update the
   webhook's secret on GitHub to the new value, then drop `GITHUB_WEBHOOK_SECRET_PREVIOUS` once
   you're confident no in-flight deliveries still use the old one.

Your webhook receiver must be reachable from GitHub's servers — for local development, tunnel it
first (e.g. `ngrok http 4000`) and use the tunnel's HTTPS URL as the payload URL; GitHub cannot
reach `localhost` directly.

#### Local development with ngrok

```bash
ngrok config add-authtoken <your-authtoken>   # one-time — from your ngrok dashboard, required even free
./scripts/start-minicoder.sh                  # API on :4000 by default
ngrok http 4000                                # in a separate terminal
```

ngrok prints a forwarding URL like `https://a1b2c3d4.ngrok-free.app`. Use
`https://a1b2c3d4.ngrok-free.app/webhooks/github` as the webhook's **Payload URL** in step 3 above
— everything else (secret, content type, event selection) is unchanged.

- Inspect live deliveries at ngrok's local dashboard, `http://127.0.0.1:4040` — the fastest way to
  check whether a signature/payload actually arrived as expected. GitHub's own
  **Settings → Webhooks → Recent Deliveries** also lets you replay a delivery without triggering a
  new PR event.
- The free tier's URL changes on every restart, so you'd need to update the webhook's Payload URL
  each time — claim ngrok's one free static/reserved domain per account instead
  (`ngrok http --domain=your-name.ngrok-free.app 4000`) if you're testing repeatedly.
- The tunnel exposes your local API to the public internet while it's running. Every route except
  `/webhooks/*` and `/healthz`/`/readyz` still requires a valid `MINICODER_API_KEYS` bearer token,
  but only run the tunnel while actively testing — don't leave it up unattended.
- Using `--webhook-only` (`minicoder github serve`, port `3100` by default) instead of the full API?
  Point ngrok at `3100` — the payload path is still `/webhooks/github`.

### 3.2 First-time setup

```bash
pnpm install
minicoder db migrate
minicoder db validate        # confirms every expected table/index exists
```

### 3.3 Environment variables at a glance

| Concern                      | Variable                                                    | Notes                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Database                     | `DB_DIALECT`                                                | `sqlite` (default) or `postgres`                                                                                         |
| Database (SQLite)            | `DB_PATH`                                                   | Defaults to `./minicoder.db`                                                                                             |
| Database (PostgreSQL)        | `DB_URL`                                                    | Required when `DB_DIALECT=postgres`                                                                                      |
| API auth (server)            | `MINICODER_API_KEYS`                                        | JSON array of `{key, id, role, actorKind, displayName?}`                                                                 |
| API auth (client/CLI/UI)     | `MINICODER_API_KEY`                                         | One raw key from the array above                                                                                         |
| API location (client/CLI/UI) | `MINICODER_API_URL`                                         | Defaults to `http://localhost:4000`                                                                                      |
| GitHub                       | `GITHUB_TOKEN`                                              | Used by the coder/reviewer adapters, `merge`, and `state doctor --check-scm` (GitHub-provider repos)                     |
| Gitea                        | `GITEA_TOKEN`                                               | Used by `state doctor --check-scm` (Gitea-provider repos)                                                                |
| GitLab                       | `GITLAB_TOKEN`                                              | Used by `state doctor --check-scm` (GitLab-provider repos)                                                               |
| GitHub webhooks              | `GITHUB_WEBHOOK_SECRET`                                     | Required by both `minicoder github serve` and `minicoder api serve`                                                      |
| GitHub webhooks (rotation)   | `GITHUB_WEBHOOK_SECRET_PREVIOUS`                            | Optional, for secret rotation                                                                                            |
| LLM provider                 | `CODE_GEN_BASE_URL` / `CODE_GEN_API_KEY` / `CODE_GEN_MODEL` | Any OpenAI-compatible endpoint; shared by the coder, reviewer, planner, arbiter, and (by default) documentation adapters |
| Observability (optional)     | `OTEL_EXPORTER_OTLP_ENDPOINT`                               | If unset, `observability export-otel` is a no-op                                                                         |
| Web UI                       | (none new)                                                  | Reads the same `MINICODER_API_URL`/`MINICODER_API_KEY` as the CLI                                                        |

### 3.4 Getting the `minicoder` binary on your PATH

`pnpm install` alone does not put a `minicoder` executable directly on your shell's `PATH` — the
CLI's `bin` entry points at a TypeScript source file run via a `tsx` shebang. You also need
`pnpm build` once (the CLI depends on the compiled `dist/` output of `@minicoder/core`,
`@minicoder/api`, etc. — not just their source). From the repo root:

```bash
pnpm install
pnpm build
```

Then, to actually invoke it, use whichever of these fits how you're working:

```bash
pnpm exec minicoder <command>                          # resolves the workspace-linked bin
pnpm --filter @minicoder/cli exec minicoder <command>   # equivalent, explicit about which package
./bin/minicoder <command>                               # repo-provided wrapper — see below
```

`./bin/minicoder` (`bin/minicoder` in the repo root) is a small wrapper script that resolves the
repo root from its own location and runs
`pnpm -C <repo-root> --filter @minicoder/cli exec tsx src/index.ts "$@"` — it exists so `minicoder`
can be made a real, PATH-resolvable global command (see 3.4.1) without publishing a package.

(A packaged/compiled distribution may expose `minicoder` directly — check your deployment's own
install instructions if you're not running from a source checkout.)

#### 3.4.1 Installing `minicoder` as a global command, by scenario

**Local development (editing MiniCoder itself).** No install needed — just use `./bin/minicoder`
or `pnpm exec minicoder` from the repo root, as above.

**Global command on your own workstation** — so `minicoder` works from any directory, for any
project:

```bash
sudo ln -s "$(pwd)/bin/minicoder" /usr/local/bin/minicoder
# or, without sudo, per-user (ensure ~/.local/bin is on PATH):
mkdir -p ~/.local/bin && ln -s "$(pwd)/bin/minicoder" ~/.local/bin/minicoder
minicoder status --project <id>   # now works from anywhere
```

**Operator on a laptop, talking to an already-running hosted deployment** — no local database, no
local server processes, just the Text UI's HTTP-only commands:

```bash
export MINICODER_API_URL=https://minicoder.example.com
export MINICODER_API_KEY=<your-issued-key>
minicoder status --project <id>
minicoder features --project <id>
```

`DB_*`/`GITHUB_WEBHOOK_SECRET`/adapter env vars are irrelevant here — only the API client vars
above matter, since every read/dashboard command in 5.5 and the generic-dispatch commands in 5.0
talk over HTTP, never the database directly.

**CI pipeline.** Don't install a global binary — invoke the same way each step needs it, no
symlink required:

```yaml
- run: corepack enable && pnpm install --frozen-lockfile && pnpm build
- run: pnpm --filter @minicoder/cli exec tsx src/index.ts db migrate
- run: pnpm --filter @minicoder/cli exec tsx src/index.ts plan submit-for-approval --plan "$PLAN_ID" --project "$PROJECT_ID"
```

**Long-running server (staging/production).** See 3.5 — run `scripts/start-minicoder.sh` under a
real process supervisor (systemd, Docker, k8s), and use `./bin/minicoder`/a global symlink for the
one-shot commands (approvals, `human ...`, `merge merge-if-ready`, etc.) an operator runs against
it afterward.

### 3.5 Start the long-running processes

MiniCoder is a handful of independent, always-on processes plus a normal CLI. In a real deployment
you run all of these (each in its own terminal, container, or service):

```bash
minicoder api serve                 # the Orchestrator API — the UIs and most read commands need this
minicoder tasks worker              # executes queued automation (coding, review, merge-gate, etc.)
```

**`scripts/start-minicoder.sh` does this for you in one command**, with sensible local-dev
defaults, and is the recommended way to stand up a deployment (including production, under a
process supervisor — see 3.5.1):

```bash
./scripts/start-minicoder.sh                    # sqlite, 1 task worker, API + webhooks on :4000
WORKER_COUNT=3 ./scripts/start-minicoder.sh      # scale to 3 task workers
START_WEB_UI=true ./scripts/start-minicoder.sh   # also start the Web UI (packages/web) on :3000
./scripts/start-minicoder.sh --webhook-only      # dev-only: minicoder github serve instead of api serve
./scripts/start-minicoder.sh --help              # full option/env-var reference
```

It loads a `.env` file from the repo root if present, runs `minicoder db migrate` before starting
anything, waits for `/healthz` before printing its summary, and stops every process cleanly
(no orphaned workers, no held ports) on Ctrl-C or `SIGTERM`. In local development, unset
`MINICODER_API_KEYS`/`GITHUB_WEBHOOK_SECRET` are filled in with clearly-labeled dev-only
placeholders (printed to the console so you know to use them); with `APP_ENV=production` it
refuses to start instead of inventing a production secret — set both for real first. Logs for each
process land in `logs/<process-name>.log`.

Everything below this point describes what the script does under the hood — useful for
understanding what's running, tuning an individual process, or wiring your own process supervisor
instead of using the script directly.

**Webhook receiver — pick one, not both.** `minicoder api serve` already mounts
`POST /webhooks/github` itself (and requires `GITHUB_WEBHOOK_SECRET` to start, exactly like the
standalone receiver). `minicoder github serve` is a _second_, standalone Fastify process exposing
the same route on its own port. Point your GitHub repository's webhook at whichever one you
actually run — normally that's the API's own `/webhooks/github` (one fewer process to run), with
`minicoder github serve` reserved for topologies that want the webhook receiver decoupled from the
API process. Don't register the same GitHub webhook against both.

Configure the API's key(s) via `MINICODER_API_KEYS` (a JSON array of
`{key, id, role, actorKind, displayName?}` objects — this is the whole auth model, there's no
separate login system). Then, for any CLI command or UI that talks to the API:

```bash
export MINICODER_API_URL=http://localhost:4000   # default if omitted
export MINICODER_API_KEY=<one of the keys from MINICODER_API_KEYS>
```

Configure `GITHUB_WEBHOOK_SECRET` on whichever process receives the webhook, and the
coder/reviewer's `GITHUB_TOKEN` / `CODE_GEN_BASE_URL` / `CODE_GEN_API_KEY` / `CODE_GEN_MODEL`.

**Adapter registry bootstrap.** Every adapter invocation (coder, reviewer, arbiter, planner,
documentation) resolves its adapter name against the `AdapterRegistry` table for provenance —
there is no CLI or API command to register an adapter (`minicoder adapters` is read-only). Your
deployment needs its own one-time bootstrap step that calls `AdapterRegistry.register()` directly
(e.g. a small setup script, run once against the database) for each adapter name you intend to
reference — including the default `CodexCoderAdapter` / `ClaudeReviewerAdapter` /
`ClaudeArbiterAdapter` / `GenericLLMPlannerAdapter` / `ClaudeDocumentationAdapter` reference
implementations. This manual doesn't prescribe that script since it's deployment-specific; without
it, any command that names an adapter (`design-doc request-run --documentation-adapter ...`, the
`request-coder-run`/`request-review`/`request-design-doc` API routes) will fail to resolve it.

#### 3.5.1 Running `scripts/start-minicoder.sh` in production

The script itself does not daemonize — run it under a real supervisor so it restarts on crash and
starts on boot. Two examples:

**systemd** (`/etc/systemd/system/minicoder.service`):

```ini
[Unit]
Description=MiniCoder
After=network.target

[Service]
WorkingDirectory=/opt/minicoder
EnvironmentFile=/opt/minicoder/.env
ExecStart=/opt/minicoder/scripts/start-minicoder.sh
Restart=on-failure
User=minicoder

[Install]
WantedBy=multi-user.target
```

**Docker**: build an image with `pnpm install && pnpm build` baked in, then
`CMD ["./scripts/start-minicoder.sh"]`, supplying `DB_URL`, `MINICODER_API_KEYS`,
`GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, and the `CODE_GEN_*` vars as container environment
variables (never baked into the image).

In both cases, set `APP_ENV=production`, `DB_DIALECT=postgres` with a real `DB_URL` (SQLite is
local/single-node only — never on a network filesystem), and real values for
`MINICODER_API_KEYS`/`GITHUB_WEBHOOK_SECRET`/`GITHUB_TOKEN`/`CODE_GEN_*` — the script will refuse
to start without the first two once `APP_ENV=production` is set.

### 3.6 Optional: the Text UI and Web UI

Every `minicoder <noun>` command below (`status`, `plan`, `features`, ...) _is_ the Text UI — no
separate install. For the Web UI, run `packages/web`'s Next.js server (it reads the same
`MINICODER_API_URL`/`MINICODER_API_KEY`), and put it behind a trusted/internal network — it holds
one shared API credential for every visitor, with no per-user login yet.

---

## 4. End-to-end walkthrough: building a project with MiniCoder

This walks through taking a specification all the way to a merged, documented project. Replace
`<project>` with your actual project ID throughout.

### Step 1 — Ingest your specification

Feed MiniCoder your spec (a plain-text/markdown description of what you want built). This kicks
off a planner-adapter-backed readiness assessment.

```bash
minicoder spec ingest spec.md --project <project>
```

Once ingested, check readiness and whether clarification is needed:

```bash
minicoder status --project <project>
minicoder plan --project <project>
```

### Step 2 — Answer clarifying questions (if any)

If the readiness assessment came back `insufficient`, MiniCoder opens a clarification session and
asks questions before it will draft a plan.

```bash
minicoder clarification --project <project>
```

Answer each question:

```bash
minicoder clarification answer --project <project> --session <sessionId> \
  --question <questionId> --text "<your answer>"
```

There's a hard limit of 3 rounds and a per-round timeout — if you don't answer in time, the session
is marked `clarification_blocked` and escalated to a human. Once every question in the current
round is answered, the session completes (`clarification_complete`) and plan generation can
proceed.

### Step 3 — Review and approve the plan

Once a plan and its feature backlog exist:

```bash
minicoder plan --project <project>
minicoder features --project <project>
```

If you'd rather hand-author the backlog, write a `backlog.md` and import it:

```bash
minicoder plan import-backlog backlog.md --project <project> --plan <planId> --actor <you> --dry-run
minicoder plan import-backlog backlog.md --project <project> --plan <planId> --actor <you>
```

Submission for approval requires the backlog to have passed validation with no unresolved blocking
gaps:

```bash
minicoder plan submit-for-approval --project <project> --plan <planId>
```

Approving and activating a plan requires `approver`/`admin` — this is where the plan moves
`draft → pending_approval → approved → activated_for_execution`, and every feature request becomes
a feature run at `approved_pending_execution`:

```bash
minicoder plan approve --project <project> --plan <planId> --yes
minicoder plan activate --project <project> --plan <planId> --yes
```

### Step 4 — Let automation run, and watch it work

Once activated, `start-next-feature` picks the next eligible feature (respecting dependency order
and the one-feature-at-a-time rule), and the pipeline runs on its own: coding → push → PR → CI →
review → fix loop (if needed) → policy approval. Watch it:

```bash
minicoder status --project <project>       # overall dashboard
minicoder active --project <project>       # what's being worked on right now, its PR/CI state
minicoder runs --project <project>         # agent run history
minicoder runs --timeline <featureRunId>   # one feature's full chronological history
```

If you need to pause everything (say, before a maintenance window) and resume later:

```bash
minicoder pause --project <project> --yes
minicoder resume --project <project> --yes
```

### Step 5 — Handle anything that needs you

Two things route to a human: a feature stuck at `human_required`, or one `blocked` on an unmet
dependency.

```bash
minicoder features --project <project> --human-required
```

For each one, decide and act:

```bash
# The reviewer/coder disagreed and it was escalated — you decide who's right
minicoder human resolve-disagreement --feature-run <id> --project <project> --actor <you> \
  --resolution "the reviewer's concern is valid, needs a fix"

# You're satisfied nothing further is needed — send it back to review
minicoder human resume --feature-run <id> --project <project> --actor <you> --notes "false alarm"

# Start this feature over from scratch
minicoder human retry --feature-run <id> --project <project> --actor <you> --notes "retry after infra fix"

# Give up on this feature entirely (terminal)
minicoder human skip --feature-run <id> --project <project> --actor <you> --notes "descoped"

# Block it on something external (and unblock once resolved)
minicoder human block --feature-run <id> --project <project> --actor <you> --notes "waiting on API access"
minicoder human unblock --feature-run <id> --project <project> --actor <you> --notes "access granted"
```

Also watch for a budget pause: if a project hits a soft/hard cost limit, it moves to
`waiting_for_budget_approval`/`paused_budget_exceeded` and needs an approver override before
automation continues (check `minicoder costs --project <project>` and `minicoder status`):

```bash
minicoder budget approve-override --project <project> --policy <policyId> \
  --reason "approved extra spend for this sprint" --yes
```

### Step 6 — Approve and execute merges

When a feature's review passes and the merge gate is satisfied, it reaches `approved_by_policy`.
An approver merges it:

```bash
minicoder merge merge-if-ready --feature-run <id> --project <project> --actor <you>
```

This re-checks the merge gate one more time, then merges on GitHub, then records the result. If
GitHub reports the merge succeeded but MiniCoder failed to record it, recover with:

```bash
minicoder merge finalize-if-github-merged --feature-run <id> --project <project>
```

### Step 7 — Repeat until the backlog is done

Steps 4–6 repeat automatically, one feature at a time, until every feature request is `merged` or
`skipped`.

### Step 8 — Final design document

Once every feature is merged (or skipped) and Project Acceptance Validation passes, mark
implementation complete (you must also attest that CI-only checks — the full test suite, build,
lint, security scan — have passed out-of-band, since MiniCoder's own database can't run those
itself). **This command, and `project complete` in Step 9, require a `system`-actorKind API key,
not an ordinary approver key** — the underlying handlers are gated to system/admin credentials, so
your `MINICODER_API_KEYS` entry for this step needs `"actorKind": "system"`:

```bash
minicoder project validate-acceptance --project <project>          # preview, no transition
minicoder project mark-implementation-complete --project <project> \
  --evidence "CI run https://github.com/org/repo/actions/runs/123 all green" --yes
```

Generate the design document, review it, and either send it back for changes or approve it. The
`--documentation-adapter` name (below, `ClaudeDocumentationAdapter`) must already be registered in
your deployment's `AdapterRegistry` — see the bootstrap note in
[§3.5](#35-start-the-long-running-processes):

```bash
minicoder design-doc generate --project <project> --yes
minicoder design-doc request-run --project <project> --documentation-adapter ClaudeDocumentationAdapter
minicoder design-doc --project <project>                                   # read the drafted sections

# if it needs changes:
minicoder design-doc request-revision --project <project> --document <docId> --notes "expand the risk section" --yes
minicoder design-doc regenerate --project <project> --yes

# once satisfied:
minicoder design-doc approve --project <project> --document <docId> --yes
```

### Step 9 — Complete the project

```bash
minicoder project complete --project <project> --yes
```

The project is now `project_complete`. `minicoder artifacts --project <project>` will show the
exported `final-design-document.md` (and the earlier `plan.md`/`backlog.md` snapshots).

---

## 5. Complete command reference

Conventions used below:

- **Transport** tells you what the command actually talks to: **API** (the Orchestrator API over
  HTTP — needs `minicoder api serve` running and `MINICODER_API_KEY`/`MINICODER_API_URL` set),
  **DB** (talks to the database directly — needs your DB connection env vars), or **process**
  (spawns migrations/tests/a server).
- Every **API**-transport read command supports `--json` to print the raw API response instead of
  the colorized table view.
- `<id>` placeholders are the IDs MiniCoder itself generates/returns; there's no fixed format to
  guess.

### 5.0 Generic-dispatch commands — `minicoder spec/clarification/plan/budget ...` (API)

Several lifecycle steps in the walkthrough above (spec ingestion, clarification answers, plan
submission/approval/activation, budget override) are reached through the Orchestrator API's
generic dispatch route, `POST /commands/:commandSlug`, which every registered command handler is
reachable through by a slugified version of its name (e.g. `IngestSpecificationCommand` →
`ingest-specification`). Each now has a dedicated CLI command:

```bash
minicoder spec ingest <file> --project <project> [--content-type text/plain]

minicoder clarification answer --project <project> --session <sessionId> \
  --question <qId> --text "<your answer>"
  # expectedQuestionVersion is fetched automatically from the session — no manual lookup needed

minicoder plan submit-for-approval --project <project> --plan <planId>

minicoder plan approve --project <project> --plan <planId> --yes [--notes "looks good"]
  # requires an approver/admin-role key

minicoder plan activate --project <project> --plan <planId> --yes
  # requires an approver/admin-role key

minicoder budget approve-override --project <project> --policy <policyId> \
  --reason "approved extra spend for this sprint" --yes
  # requires an approver/admin-role key; --policy is the budget_policies row being overridden
```

Every one of these fetches its own `expectedVersion`/`expectedQuestionVersion` (an
optimistic-concurrency check) live before dispatching, and mints a fresh `Idempotency-Key` per
invocation by default — you never need to compute either by hand. If a command times out or you
lose its response before knowing whether it succeeded, pass `--idempotency-key <key>` on the retry
to reuse the exact same key instead of risking a duplicate side effect from a second, differently-
keyed submission.

If you need to call a command with no dedicated CLI wrapper yet, every registered handler remains
reachable directly via `POST /commands/:commandSlug` (`GET /commands` lists every slug currently
registered) — this needs `Authorization: Bearer <MINICODER_API_KEY>` and a client-chosen
`Idempotency-Key` header (any unique string per logical submission — reusing one replays the
original result rather than re-running the command). A handful of operations still have no CLI
wrapper — `export-plan`, `export-backlog`, `start-clarification`, `complete-clarification`
(tracked in [issue #81](https://github.com/jhoar/MiniCoder/issues/81)) — as well as any future
command added to the registry before its own CLI wrapper lands. Example, exporting a plan snapshot
directly:

```bash
curl -X POST "$MINICODER_API_URL/commands/export-plan" \
  -H "Authorization: Bearer $MINICODER_API_KEY" \
  -H "Idempotency-Key: export-plan-$(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"planId":"<planId>","projectId":"<project>"}'
```

### 5.0.1 Task-enqueue commands — `minicoder run ...` / `minicoder design-doc request-run` (API)

Five routes each enqueue a whole background task (coding, review, merge-gate recompute, or
design-doc generation) rather than executing synchronously. All require an **operator**-role (or
above) API key; the CLI mints the `Idempotency-Key` for you by default (or pass
`--idempotency-key <key>` to reuse one after a timeout/lost response) and prints
`enqueued:<triggerdevRunId>` on success.

```bash
minicoder run coder --project <project> --feature-run <id> --coder-adapter CodexCoderAdapter

minicoder run review --project <project> --feature-run <id> \
  --reviewer-adapter ClaudeReviewerAdapter [--arbiter-adapter ClaudeArbiterAdapter]

minicoder run fixes --project <project> --feature-run <id> \
  --reviewer-adapter ClaudeReviewerAdapter
  # re-triggers the review task — there is no separate "fixes" task

minicoder run merge-gate --project <project> --feature-run <id>

minicoder design-doc request-run --project <project> --documentation-adapter ClaudeDocumentationAdapter
```

Every `...-adapter` value must already exist in the `AdapterRegistry` — see the adapter registry
bootstrap note in [§3.5](#35-start-the-long-running-processes).

### 5.1 Database lifecycle — `minicoder db ...` (DB)

| Subcommand | Purpose                                                                         | Key flags                                                                             |
| ---------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `migrate`  | Apply all pending migrations.                                                   | —                                                                                     |
| `rollback` | Roll back the most recently applied migration.                                  | —                                                                                     |
| `status`   | Show applied vs. pending migrations.                                            | —                                                                                     |
| `validate` | Verify every expected table/index exists.                                       | —                                                                                     |
| `diff`     | List migrations on disk not yet applied.                                        | —                                                                                     |
| `seed`     | Insert fixture data. **Dev/test/CI only** (SQLite only).                        | `--fixture <name>` (default `planning-review-merge`), `--env <env>`, `--project <id>` |
| `snapshot` | Copy the current SQLite file to a backup, with a metadata sidecar. SQLite only. | `--output <path>` (required, must not exist)                                          |
| `restore`  | Restore SQLite from a snapshot. **Dev/test/CI only.**                           | `--input <path>` (required), `--env <env>`, `--yes` (required)                        |
| `reset`    | Drop and re-migrate everything. **Guarded, destructive, two-step.**             | See below                                                                             |

`db reset` is deliberately heavy-handed:

```bash
# Step 1 — preview and get a confirmation token (expires in 5 minutes)
minicoder db reset --dry-run --env development --actor <you> --backup-verified

# Step 2 — actually do it
minicoder db reset --apply --yes --confirmation <token> --env development --actor <you> --backup-verified
```

Flags: `--env <env>` (required; must be `development`/`test`/`ci` and, if `APP_ENV`/`NODE_ENV` is
set, must match it exactly), `--actor <name>` (required, audit-logged), `--backup-verified` or
`--backup-exempt "<reason>"` (one required), `--disposable-db` (required only if
`APP_ENV`/`NODE_ENV` is completely unset), `--force-host <host>` (only if resetting a PostgreSQL
host not in `MINICODER_ALLOWED_RESET_HOSTS`). Refuses unconditionally if `APP_ENV`/`NODE_ENV` is
`production`, no matter what `--env` says.

### 5.2 Task queue (Workflow Layer) — `minicoder tasks ...` / `minicoder trigger ...` (DB)

`minicoder tasks` runs the actual worker:

| Subcommand | Purpose                                                                                                                            | Key flags                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `worker`   | Long-running process: polls the task queue and executes claimed tasks until you stop it (Ctrl-C lets in-flight work finish first). | `--poll-interval-ms`, `--batch-size`, `--stale-claim-ms`           |
| `drain`    | One-shot: waits until the queue is empty or a timeout elapses (CI use). Exits non-zero on timeout with work left.                  | `--timeout-ms` (default 60000), `--poll-interval-ms` (default 500) |

`minicoder trigger` inspects/manages individual queued runs (a management console, not a worker):

| Subcommand            | Purpose                                                                      | Key flags                                                                          |
| --------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `deploy`              | No-op (prints the list of registered task IDs — nothing external to deploy). | —                                                                                  |
| `list-runs`           | List recent runs.                                                            | `--task <id>`, `--limit <n>` (default 20)                                          |
| `inspect-run <runId>` | Show one run's detail.                                                       | positional `runId`                                                                 |
| `cancel-run <runId>`  | Force-fail a stuck run so the worker stops retrying it.                      | positional `runId`                                                                 |
| `replay-run <runId>`  | Re-enqueue a run with a fresh idempotency key.                               | positional `runId`                                                                 |
| `drain-queue`         | Same as `tasks drain`.                                                       | `--timeout-ms`, `--poll-interval-ms`                                               |
| `reset-dev`           | Wipe the whole task queue. **Dev/test/CI only.**                             | `--yes` (required), `--env <env>` (required, must agree with `APP_ENV`/`NODE_ENV`) |
| `validate`            | Confirm every canonical task ID has a registered handler.                    | —                                                                                  |
| `reconcile`           | Flag runs whose queue row and run-status row have drifted apart.             | `--project <id>`                                                                   |

### 5.3 GitHub integration — `minicoder github ...`

| Subcommand                                                                                                                                                                                                                  | Purpose                                                                                                                                                       | Transport | Key flags                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve`                                                                                                                                                                                                                     | Run the real webhook receiver (`POST /webhooks/github`). Long-running; not environment-guarded — this is meant for production. Needs `GITHUB_WEBHOOK_SECRET`. | process   | `--port` (default 3100), `--host` (default `0.0.0.0`)                                                                                                            |
| `simulate-pr-opened` / `simulate-pr-closed` / `simulate-pr-merged` / `simulate-check-passed` / `simulate-check-failed` / `simulate-review-approved` / `simulate-review-changes-requested` / `simulate-branch-protection-ok` | Fake the corresponding GitHub event locally, without a real webhook. **Dev/test/CI only.**                                                                    | DB        | `--project <id>` (required), `--pr-number <n>` (required), plus event-specific optionals (`--merged`, `--check-name`, `--reviewer`, `--head-sha`, `--merge-sha`) |

### 5.4 Orchestrator API — `minicoder api serve` (process)

Starts the Fastify API everything else in this table depends on. `--port` (default 4000),
`--host` (default `0.0.0.0`). Stays running until stopped; doesn't close the DB connection.

### 5.5 Read/dashboard commands (all API transport, all support `--json`)

| Command                                                | Shows                                                                                           | Key flags                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `status --project <id>`                                | Project + automation state, task-queue health, (if your key is operator+) doctor-check summary. | `--project` (required)                                                            |
| `plan --project <id>`                                  | The implementation plan and readiness assessment.                                               | `--project` (required)                                                            |
| `clarification --project <id> [--session <id>]`        | Clarification questions/answers, one session or the latest.                                     | `--project` (required), `--session`                                               |
| `features --project <id> [--human-required]`           | The feature backlog, or (with the flag) only features parked at `human_required`.               | `--project` (required), `--human-required`, `--cursor`, `--limit`                 |
| `active --project <id>`                                | The one feature currently in flight and its linked PR/CI status.                                | `--project` (required)                                                            |
| `runs [--project <id>] [--feature-run <id>]`           | Agent run history.                                                                              | `--project`, `--feature-run`, `--cursor`, `--limit`                               |
| `runs --timeline <featureRunId>`                       | One feature's full merged chronological history (events, runs, findings, PR, cost, approvals).  | positional-ish `--timeline <id>`                                                  |
| `findings --feature-run <id>`                          | Review findings for one feature run.                                                            | `--feature-run` (required), `--cursor`, `--limit`                                 |
| `disagreements [--feature-run <id>] [--state <state>]` | Coder/reviewer disagreements (global if unfiltered).                                            | `--feature-run`, `--state` (`open`/`escalated`/`resolved`), `--cursor`, `--limit` |
| `costs --project <id>`                                 | Raw cost records + active budget policies.                                                      | `--project` (required)                                                            |
| `costs --project <id> --report [--window-days <n>]`    | Aggregate spend by scope/feature/provider/model/role.                                           | `--report`, `--window-days`                                                       |
| `artifacts --project <id>`                             | Generated artifact exports (plan.md, backlog.md, final-design-document.md, ...).                | `--project` (required), `--cursor`, `--limit`                                     |
| `adapters [--adapter <id>]`                            | Registered AI adapters and their configurations (read-only).                                    | `--adapter`                                                                       |

### 5.6 Plan and backlog — `minicoder plan ...`

| Subcommand              | Transport | Purpose                                                                                | Key flags                                                                                                                            |
| ----------------------- | --------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| _(bare)_                | API       | Default view: plan + readiness.                                                        | `--project` (required)                                                                                                               |
| `import-backlog <file>` | DB        | Parse, validate, preview, and (unless `--dry-run`) import a hand-written `backlog.md`. | positional file, `--project` (required), `--plan` (required), `--actor` (required), `--actor-role` (default `approver`), `--dry-run` |

### 5.7 Design document — `minicoder design-doc ...` (API)

| Subcommand         | Transitions                                                                                             | Role needed | Key flags                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _(bare)_           | — (read-only)                                                                                           | any         | `--project` (required), `--document <id>`                                                                                                                    |
| `generate`         | `implementation_complete → design_document_generating`                                                  | operator+   | `--project`, `--yes` (required)                                                                                                                              |
| `regenerate`       | `design_document_revision_requested → design_document_generating`                                       | operator+   | `--project`, `--yes` (required)                                                                                                                              |
| `request-revision` | `design_document_ready_for_review → design_document_revision_requested`                                 | approver+   | `--project`, `--document` (required), `--notes`, `--yes` (required)                                                                                          |
| `approve`          | `design_document_ready_for_review → design_document_approved`                                           | approver+   | `--project`, `--document` (required), `--notes`, `--yes` (required)                                                                                          |
| `request-run`      | Enqueues the drafting task (calls the `DocumentationAgentAdapter`, exports `final-design-document.md`). | operator+   | `--project`, `--documentation-adapter <name>` (required; must already be registered in `AdapterRegistry` — see [§3.5](#35-start-the-long-running-processes)) |

### 5.8 Project lifecycle — `minicoder project ...` (API)

`mark-implementation-complete` and `complete` require a **`system`-actorKind** API key (not an
ordinary human `approver`/`admin` key) — their command handlers are gated to system credentials.

| Subcommand                     | Transitions                                                                  | Role/kind needed | Key flags                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `mark-implementation-complete` | `active → implementation_complete` (Project Acceptance Validation must pass) | system-kind      | `--project` (required), `--evidence <text>` (required — your attestation that CI-only checks passed), `--yes` (required) |
| `validate-acceptance`          | (read-only) previews Project Acceptance Validation                           | any              | `--project` (required)                                                                                                   |
| `complete`                     | `design_document_approved → project_complete`                                | system-kind      | `--project` (required), `--yes` (required)                                                                               |

### 5.9 Automation control — `minicoder pause` / `minicoder resume` (API, operator+)

Both require `--project <id>` and `--yes`. `pause`: `running → paused_by_operator`. `resume`:
`paused_by_operator → running`.

### 5.10 Human escalation — `minicoder human ...` (DB, dispatches state-machine commands directly)

All subcommands take `--feature-run <id>` (required), `--project <id>` (required), `--actor <id>`
(required — your identity for the audit trail), `--actor-role` (default `approver`), plus:

| Subcommand             | Transition                             | Extra flags                                                                                         |
| ---------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `resolve-disagreement` | `human_required → changes_requested`   | `--resolution <text>` (required), `--disagreement <id>` (optional, defaults to the latest open one) |
| `resume`               | `human_required → under_review`        | `--notes <text>` (required), `--disagreement <id>` (optional)                                       |
| `retry`                | `human_required → selected`            | `--notes <text>` (required)                                                                         |
| `skip`                 | `human_required → skipped` (terminal)  | `--notes <text>` (required)                                                                         |
| `block`                | `human_required → blocked`             | `--notes <text>` (required)                                                                         |
| `unblock`              | `blocked → approved_pending_execution` | `--notes <text>` (required)                                                                         |

### 5.11 Merge — `minicoder merge ...` (DB + real GitHub API calls)

| Subcommand                  | Purpose                                                                                                                                               | Key flags                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merge-if-ready`            | Re-evaluates the merge gate, then merges via GitHub, then records the result (or the failure/escalation).                                             | `--feature-run` (required), `--project` (required), `--actor` (required), `--actor-role` (default `approver`), `--merge-method` (default `squash`; `squash`\|`merge`\|`rebase`) |
| `finalize-if-github-merged` | Recovery: use when GitHub shows the PR merged but MiniCoder never recorded it. Always re-verifies against GitHub first — refuses if GitHub disagrees. | `--feature-run` (required), `--project` (required)                                                                                                                              |

### 5.12 Diagnostics and repair — `minicoder state ...` (DB)

| Subcommand           | Purpose                                                                               | Key flags                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `inspect`            | Show one project's or feature run's current state, locks, findings, recent events.    | `--project` or `--feature-run` (one required)                                                            |
| `validate`           | Confirm every feature-run state is a recognized value.                                | `--project`                                                                                              |
| `doctor`             | Detect stale locks, stuck queues, orphaned runs. Exits 1 if unhealthy.                | `--project`, `--check-scm` (opt-in, needs a provider credential; `--check-github` is a deprecated alias) |
| `reconcile`          | Clear the anomalies `doctor` found.                                                   | `--project <id>` (project-scoped) or `--all` (global; one is required)                                   |
| `export-diagnostics` | Dump full diagnostics as JSON.                                                        | `--project`, `--output <path>`                                                                           |
| `repair`             | Guarded, two-step repair of orphaned runs (5-minute single-use token, project-bound). | `--project` (required always), then `--dry-run` or `--apply --confirmation <token>`                      |

### 5.13 Observability — `minicoder observability export-otel` (DB)

Exports `workflow_events` to an OpenTelemetry collector configured via
`OTEL_EXPORTER_OTLP_ENDPOINT` (no-ops if unset). Meant to be called by your own scheduler (cron,
k8s CronJob), not run continuously. `--cursor-id <id>` (default `workflow_events_otlp`),
`--limit <n>` (max events per invocation).

### 5.14 Testing — `minicoder test ...` (process)

| Subcommand        | Runs                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit`            | Fast unit tests only.                                                                                                                                                                                                                 |
| `integration`     | `*.integration.test.ts` files against a real DB.                                                                                                                                                                                      |
| `system`          | Every end-to-end scenario.                                                                                                                                                                                                            |
| `scenario <name>` | One named scenario (e.g. `planning-basic`, `review-loop`, `merge-gate`, `disagreement-arbiter`, `design-document-lifecycle` — the more complete end-to-end Phase 17 scenario, exercising the full project-lifecycle/design-doc flow). |

---

## 6. Troubleshooting and recovery

**"Nothing is happening" / automation seems stuck.**
Run `minicoder status --project <project>` and `minicoder state doctor --project <project>`.
Check whether automation is `paused_by_operator` (someone paused it — `minicoder resume`) or
`paused_budget_exceeded`/`waiting_for_budget_approval` (needs an approver's budget override).
Confirm `minicoder tasks worker` is actually running — nothing advances without it.

**A feature is stuck at `human_required`.**
That's by design — see [§4 Step 5](#step-5--handle-anything-that-needs-you). Use
`minicoder findings --feature-run <id>` and `minicoder disagreements --feature-run <id>` to see
why, then one of the `minicoder human ...` subcommands.

**A feature is `blocked`.**
Usually an unmet dependency on another feature. Check `minicoder features --project <project>` for
the dependency's state; once it merges, `blocked` clears on its own. If a human explicitly caused
the block, use `minicoder human unblock`.

**GitHub shows a PR merged but MiniCoder still shows `merge_ready`.**
Run `minicoder merge finalize-if-github-merged --feature-run <id> --project <project>`.

**Suspected drift between MiniCoder and its linked SCM provider (stuck locks, a PR MiniCoder never
noticed).**
`minicoder state doctor --project <project> --check-scm` (needs the relevant provider credential —
`GITHUB_TOKEN`/`GITEA_TOKEN`/`GITLAB_TOKEN`; `--check-github` remains a deprecated alias), then
`minicoder state reconcile --project <project>` (or `--all` for a global sweep, which also clears
stuck queue entries).

**You're about to run a destructive `state repair --apply` or `db reset --apply`.**
Neither can be undone once applied, and neither has a bypass — that's intentional. Always run the
matching `--dry-run` first, read the preview carefully, and only proceed to `--apply` with the
token it gives you. For `db reset` specifically, take a real backup first
(`minicoder db snapshot --output <path>`) and pass `--backup-verified`, so a bad reset is
recoverable by restoring the snapshot rather than by rolling back the reset itself.

**Costs are climbing faster than expected.**
`minicoder costs --project <project> --report` for the breakdown by feature/provider/model/role;
`minicoder costs --project <project>` for the raw records.

---

## 7. Glossary quick-reference

The full canonical glossary is [`docs/00-glossary-and-terms.md`](docs/00-glossary-and-terms.md).
The terms you'll actually use day to day:

- **Feature execution states**: `approved_pending_execution`, `selected`, `coding`, `code_pushed`,
  `pr_opened`, `ci_running`, `under_review`, `changes_requested`, `fixing`, `approved_by_policy`,
  `merge_ready`, `merged` — plus the escape states `ci_failed`, `merge_failed`, `human_required`,
  `blocked`, `failed`, `system_failed`, `skipped`.
- **Automation states**: `running`, `paused_by_operator`, `paused_budget_exceeded`,
  `waiting_for_budget_approval`.
- **Planning states**: `draft`, `pending_approval`, `approved`, `activated_for_execution`.
- **Project states**: `active`, `implementation_complete`, `design_document_generating`,
  `design_document_ready_for_review`, `design_document_revision_requested`,
  `design_document_approved`, `project_complete`.
- **Roles**: `viewer`, `operator`, `approver`, `admin`.
- **Review finding severities**: `blocking`, `non_blocking`, `question`, `nit`, `out_of_scope`,
  `requires_human_decision`.
- **Feature-request IDs**: `FR-<n>` (e.g. `FR-002`); feature branches: `minicoder/FR-<n>`.
