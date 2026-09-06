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

| Command                                                                            | What it's for                                                                                                                           |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `minicoder db migrate/rollback/status/validate/diff`                               | Manage the database schema.                                                                                                             |
| `minicoder db reset`                                                               | Wipe and re-migrate the database (guarded, destructive).                                                                                |
| `minicoder db seed/snapshot/restore`                                               | Dev/test fixture and backup helpers.                                                                                                    |
| `minicoder tasks worker`                                                           | Run the background worker that executes queued automation tasks.                                                                        |
| `minicoder tasks drain`                                                            | Wait for the task queue to empty (CI/scripts).                                                                                          |
| `minicoder trigger list-runs/inspect-run/cancel-run/replay-run/reconcile/validate` | Inspect and manage individual task-queue runs.                                                                                          |
| `minicoder github serve`                                                           | Run the GitHub webhook receiver.                                                                                                        |
| `minicoder github simulate-*`                                                      | Fake a GitHub event for local testing (dev/test only).                                                                                  |
| `minicoder api serve`                                                              | Run the Orchestrator API — the backend the UIs and most CLI read commands talk to.                                                      |
| `minicoder status`                                                                 | Project dashboard: state, automation, workflow health.                                                                                  |
| `minicoder plan`                                                                   | View the implementation plan and readiness, or (`--plan <id>`) one plan's full sections.                                                |
| `minicoder plan import-backlog <file>`                                             | Import a hand-written `backlog.md`.                                                                                                     |
| `minicoder clarification`                                                          | View clarification questions/answers.                                                                                                   |
| `minicoder features`                                                               | List the feature backlog, or (`--human-required`) items awaiting a human, or (`--full`) with untruncated descriptions and dependencies. |
| `minicoder active`                                                                 | Show the one feature currently being worked on and its PR/CI status.                                                                    |
| `minicoder runs`                                                                   | List agent runs, or (`--timeline`) a merged history for one feature.                                                                    |
| `minicoder findings`                                                               | List review findings for a feature run.                                                                                                 |
| `minicoder disagreements`                                                          | List coder/reviewer disagreements.                                                                                                      |
| `minicoder costs`                                                                  | List spend, or (`--report`) an aggregate budget breakdown.                                                                              |
| `minicoder artifacts`                                                              | List generated artifacts (plan.md, backlog.md, final-design-document.md).                                                               |
| `minicoder adapters`                                                               | List registered AI adapters (read-only).                                                                                                |
| `minicoder design-doc`                                                             | View, generate, regenerate, request revision on, or approve the final design document.                                                  |
| `minicoder project`                                                                | Mark implementation complete, check acceptance validation, complete the project.                                                        |
| `minicoder pause` / `minicoder resume`                                             | Stop/restart automated execution for a project.                                                                                         |
| `minicoder human resolve-disagreement/resume/retry/skip/block/unblock`             | Disposition a feature stuck at `human_required` or `blocked`.                                                                           |
| `minicoder merge merge-if-ready`                                                   | Approve and execute a merge (the human trigger for merging).                                                                            |
| `minicoder merge finalize-if-github-merged`                                        | Recovery command if a merge succeeded on GitHub but wasn't recorded.                                                                    |
| `minicoder spec ingest <file>`                                                     | Ingest a specification file.                                                                                                            |
| `minicoder clarification answer`                                                   | Answer a clarification question.                                                                                                        |
| `minicoder clarification start/complete`                                           | Start a new clarification round, or complete the current one.                                                                           |
| `minicoder plan submit-for-approval/approve/activate`                              | Submit, approve, and activate the implementation plan.                                                                                  |
| `minicoder plan validate-backlog`                                                  | Validate the current backlog (required before `submit-for-approval` will accept it).                                                    |
| `minicoder plan resolve-gap`                                                       | Resolve a blocking planning gap (required before `submit-for-approval` will accept it if any are open).                                 |
| `minicoder plan export/export-backlog`                                             | Render a `plan.md`/`backlog.md`-equivalent artifact export.                                                                             |
| `minicoder budget approve-override`                                                | Approve a budget override for a paused project.                                                                                         |
| `minicoder run coder/review/fixes/merge-gate`                                      | Enqueue an ad hoc coder run, reviewer run, fix re-review, or merge-gate recompute.                                                      |
| `minicoder run readiness/plan-generation/backlog-generation`                       | Enqueue AI-adapter-backed generation of the readiness assessment, implementation plan, or feature backlog.                              |
| `minicoder run start-next-feature`                                                 | Select and start the next eligible feature (needed to kick off execution after activation, and again after each feature completes).     |
| `minicoder state inspect/validate/doctor/reconcile/export-diagnostics`             | Diagnose and repair workflow health.                                                                                                    |
| `minicoder state repair`                                                           | Guarded, two-step repair of orphaned runs.                                                                                              |
| `minicoder observability export-otel`                                              | Export workflow events to an OpenTelemetry collector.                                                                                   |
| `minicoder test unit/integration/system/scenario`                                  | Run the automated test suites.                                                                                                          |

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

**Quickest path** — SQLite plus a local Gitea instance, both managed for you:

```bash
pnpm install
minicoder db migrate       # or just run the next line — it does this too
./scripts/start-minicoder.sh
```

With Docker installed and running, that one command brings up a local Gitea instance via
docker compose, bootstraps a Gitea admin user and access token on first run (nothing to click
through in a web UI), applies migrations against a local SQLite file, and starts the Orchestrator
API and a task worker. This is the default configuration specifically so a fresh checkout is
usable quickly with no external accounts to sign up for. Everything below this point, plus
`--scm=github`/`--scm=gitlab`/`--db=postgres` (3.5), covers the "more complex setup" alternatives —
a real GitHub/GitLab project, PostgreSQL, and so on — which remain fully supported.

### 3.1 Prerequisites

- Node.js and `pnpm` on `PATH` (`corepack enable` if you haven't already).
- A database: SQLite (default) for local/single-node use, PostgreSQL for a more complex hosted/team
  deployment. Never put SQLite on a network filesystem.
- An SCM provider repository and a token with permission to push branches, open PRs, and merge —
  MiniCoder pushes real commits and opens real pull requests against it. **The default/quickest
  path needs nothing here**: `./scripts/start-minicoder.sh` brings up a local Gitea instance via
  Docker and bootstraps a token for you automatically (Docker itself is the only prerequisite for
  that path). A real GitHub repository (`GITHUB_TOKEN`) or a GitLab project/instance
  (`GITLAB_TOKEN`) are the "more complex setup" alternatives — see 3.1.1/3.1.2.
- An LLM provider endpoint for the coder/reviewer/planner/arbiter/documentation adapters
  (`CODE_GEN_BASE_URL`, `CODE_GEN_API_KEY`, `CODE_GEN_MODEL` — any OpenAI-compatible endpoint). Not
  needed just to bring the processes up — only once you actually run a coder/reviewer/design-doc
  task.

### 3.1.1 Generating `GITHUB_TOKEN` and `GITHUB_WEBHOOK_SECRET` (more complex setup: a real GitHub project)

This section is for connecting a real GitHub repository — the "more complex setup" alternative to
the zero-touch default described above. If you're just trying MiniCoder out, skip straight to 3.5
and run `./scripts/start-minicoder.sh` (Gitea, no token generation needed).

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

### 3.1.2 Connecting a Gitea or GitLab project

GitHub, Gitea, and GitLab are all first-class `ScmClient` implementations behind the same
provider-neutral interface (docs/06 §Phase 18 "Generic SCM Interface") — the state machine, merge
gate, and review/fix loop behave identically regardless of which one a project's repository is on.
The differences are entirely in which repository row and env vars you set up. A project's
repository is recorded with a `provider` (`github` | `gitea` | `gitlab`) and, for the two
self-hosted providers, a `base_url` pointing at your instance:

```bash
minicoder repo connect --project <id> --provider gitea --owner <owner> --name <name> \
  --base-url http://localhost:3300 --default-branch main --create --verify
```

`minicoder repo connect` registers (or, with `--force`, replaces) the one `repositories` row a
project uses; `--create` creates the repository on the SCM first if it doesn't already exist yet
(idempotent — safe to re-run), and also repairs a pre-existing-but-empty Gitea repository (zero
commits) by seeding it with a README commit, since Gitea's PR-related routes 404 with a generic
"target couldn't be found" error on an empty repo even though it otherwise exists and reports
`has_pull_requests: true`. `--verify` confirms the configured credential can actually reach it
before writing. `minicoder repo show --project <id>` displays the currently connected repository.

**If you're using the default `./scripts/start-minicoder.sh` (Gitea, no flags), `GITEA_TOKEN` and
`GITEA_BASE_URL` are already generated for you** on first run (3.5) — the token-generation steps
below are only needed if you're pointing at a Gitea/GitLab instance you set up yourself (a real
self-hosted instance, `--scm=gitlab`'s local docker-compose stack, etc.), rather than the
docker-compose Gitea the default flow manages automatically.

**`GITEA_TOKEN` / `GITLAB_TOKEN`** — used by `state doctor --check-scm` to check a repository of
that provider for undiscovered PRs. Generate one from your instance:

- **Gitea**: your user icon → **Settings → Applications → Generate New Token**, granting at least
  `repository` read/write scope (Gitea's OAu2/token scopes are coarser-grained than GitHub's
  fine-grained tokens — there is no per-permission breakdown to match line-by-line). Copy it and
  `export GITEA_TOKEN=<the token>`.
- **GitLab**: your avatar → **Edit profile → Access Tokens** (a personal access token) or, scoped
  to just one project, that project's **Settings → Access Tokens**, granting the `api` scope. Copy
  it and `export GITLAB_TOKEN=<the token>`.

**`GITEA_WEBHOOK_SECRET` / `GITLAB_WEBHOOK_SECRET`** — the same "you generate it, register it on
both sides" shape as `GITHUB_WEBHOOK_SECRET` above, with one real difference in how strongly each
side is verified (docs/07-security-and-secrets.md §3.2): Gitea authenticates deliveries with an
HMAC-SHA256 signature (`X-Gitea-Signature`), the same mechanism GitHub uses; **GitLab does not sign
its webhook payloads at all** — it sends the configured secret back verbatim in an `X-Gitlab-Token`
header, which MiniCoder compares using a constant-time string comparison. This is a materially
weaker authenticity guarantee than HMAC (a token, not a signature, so there is nothing tying it to
the specific payload bytes) — it is GitLab's webhook design, not a MiniCoder shortcut.

1. Generate a strong random value the same way as for GitHub (`openssl rand -hex 32`).
2. `export GITEA_WEBHOOK_SECRET=<value>` / `export GITLAB_WEBHOOK_SECRET=<value>`.
3. Register it on the instance side:
   - **Gitea**: repository → **Settings → Webhooks → Add Webhook → Gitea**. **Target URL**:
     `https://<your-minicoder-host>/webhooks/gitea`. **HTTP Method**: POST. **POST Content Type**:
     `application/json`. **Secret**: paste the value. **Trigger On**: "Custom Events" → select
     _Pull Request_, _Pull Request Review_, _Pull Request Comment_ (used for delivery dedup only —
     see docs/04), _Status_ (or "All Events" is fine too). **Active**, then **Add Webhook**.
   - **GitLab**: project → **Settings → Webhooks → Add new webhook**. **URL**:
     `https://<your-minicoder-host>/webhooks/gitlab`. **Secret token**: paste the value.
     **Trigger**: check _Merge request events_, _Pipeline events_, _Note events_ (comments — used
     for delivery dedup, since GitLab sends no delivery-GUID header to dedup on directly), _Push
     events_. **Enable SSL verification** (leave checked), then **Add webhook**.
4. Rotating later: same current+previous pattern as GitHub —
   `GITEA_WEBHOOK_SECRET_PREVIOUS`/`GITLAB_WEBHOOK_SECRET_PREVIOUS`.

**Running the receiver**: either mount it inside the shared API process
(`minicoder api serve` mounts `/webhooks/gitea` and/or `/webhooks/gitlab` automatically whenever
the corresponding `*_WEBHOOK_SECRET` env var is set — leaving it unset simply leaves that route
unmounted, unlike `GITHUB_WEBHOOK_SECRET`, which `minicoder api serve` currently requires
unconditionally even on a Gitea/GitLab-only deployment; see §6's troubleshooting note), or run a
provider-specific standalone receiver: `minicoder gitea serve` (port `3101` by default) /
`minicoder gitlab serve` (port `3102` by default) — the same `--webhook-only` shape as
`minicoder github serve`'s port `3100`. `minicoder gitea simulate-*` / `minicoder gitlab
simulate-*` (dev/test/CI only, `guardEnv()`-gated) mirror `minicoder github simulate-*` for local
testing without a real webhook — see §5.3 for the full subcommand list, including the two
GitLab-specific gaps (no `simulate-review-changes-requested`, no
`simulate-branch-protection-ok`) and why they don't exist.

**No scheduled auto-discovery for Gitea/GitLab yet.** GitHub's scheduled `github-reconciliation`
task auto-discovers a PR a missed webhook never reported; Gitea and GitLab have no equivalent
scheduled pass (docs/06 §Phase 18 Stage 5) — `minicoder state doctor --project <id> --check-scm`
is, for now, the only automated way to find that class of divergence on those two providers, not
just an on-demand convenience the way it is for GitHub.

### 3.1.3 The coder sandbox needs its own network path to a self-hosted Gitea/GitLab

`minicoder run coder`'s default `CodexCoderAdapter` always clones/commits/pushes from inside an
ephemeral, isolated Docker container (`CoderSandbox`, docs/07 §6) — never on the host — attached
only to the `minicoder-coder-sandbox`/`minicoder-coder-egress` networks defined in
`infra/docker-compose.coder-sandbox.yml`. Bring that stack up once, and build the sandbox image:

```bash
docker compose -f infra/docker-compose.coder-sandbox.yml up -d
docker build -t minicoder/coder-sandbox:latest infra/docker/coder-sandbox
```

**Two separate settings are both required for the sandbox container to reach Gitea/GitLab at
all — a missing `CODER_SANDBOX_HTTPS_PROXY` fails completely differently than a missing
`SCM_ALLOWED_HOST`, and it is easy to configure only one and be confused by the result.**

1. **Route the sandbox's traffic through the egress proxy at all.** `CoderSandbox`
   (`packages/adapters-coder/src/sandbox.ts`) only sets `HTTPS_PROXY`/`HTTP_PROXY` (and the
   lowercase `https_proxy`/`http_proxy`, needed for plain-HTTP git remotes) **inside the sandbox
   container** when `CODER_SANDBOX_HTTPS_PROXY` is actually configured — leave it unset and the
   container gets no proxy configuration whatsoever, then tries to resolve DNS/reach the network
   directly, which always fails outright (`Could not resolve host: ...`, or a connection timeout)
   since `minicoder-coder-sandbox` is an `internal: true` network with no route out. This is not
   an allow-list rejection — it happens regardless of what `SCM_ALLOWED_HOST` says, because no
   traffic is even being routed to the proxy yet. Set it to the egress-proxy container's own
   service name and port from `infra/docker-compose.coder-sandbox.yml`:

   ```bash
   echo 'CODER_SANDBOX_HTTPS_PROXY=http://coder-sandbox-egress-proxy:8888' >> .env
   ```

2. **Then, the sandbox's egress proxy is itself default-deny.** Set `SCM_ALLOWED_HOST` (bare
   `host[:port]` or just `host` — either works; `entrypoint.sh` strips a trailing `:port` before
   building the filter regex, since tinyproxy's own filter always matches the bare hostname,
   confirmed via a live denial log: `Proxying refused on filtered domain "host.docker.internal"`
   for a request to `host.docker.internal:3300` — an anchored `^host\.docker\.internal:3300$`
   filter entry can never match that portless comparison string, which is why an earlier version
   of this doc's "include the port" guidance produced a silent, permanent 403 with no indication
   the port was the problem) to your Gitea/GitLab instance's host in `.env`, then rebuild and
   recreate the proxy so it picks up both the code fix and the new filter rule (a plain
   `--force-recreate` alone won't pick up an `entrypoint.sh` change, since it's baked into the
   image at build time):

   ```bash
   echo 'SCM_ALLOWED_HOST=<your-gitea-host>' >> .env
   docker compose --env-file .env -f infra/docker-compose.coder-sandbox.yml up -d --build --force-recreate coder-sandbox-egress-proxy
   docker exec infra-coder-sandbox-egress-proxy-1 cat /etc/tinyproxy/filter.txt  # confirm the entry has no :port
   ```

Whichever process actually runs `minicoder tasks worker` needs to pick up both new `.env` values —
restart it after setting them, since it won't hot-reload environment changes.

**On Docker Desktop (Windows/macOS, including WSL2), `localhost` does not mean what you think it
means here.** `infra/docker-compose.gitea.yml` has no `networks:` override, so a locally-run Gitea
container sits on its own default Compose network, port-mapped to the _host_ (e.g., `3300:3000`) —
that mapping only works from the host's own network namespace. The coder-sandbox container is on
an entirely separate, isolated network with no route to it: `GITEA_BASE_URL=http://localhost:3300`
resolves fine from your host shell (where `localhost` means "this machine"), but from _inside_ the
sandbox container, `localhost` means "this container," not your host.

The fix that works with Docker Desktop's WSL2 integration: use `host.docker.internal` instead of
`localhost` everywhere — it resolves to the host machine both from containers and (with Docker
Desktop's WSL integration) directly from your WSL shell too. Confirm both directions before relying
on it (a genuinely different Docker networking setup, e.g. plain Linux without Docker Desktop, may
need a different address — see below):

```bash
# from your WSL/host shell:
curl -s http://host.docker.internal:3300/api/healthz
# from a container on the sandbox's egress network:
docker run --rm --network minicoder-coder-egress curlimages/curl \
  curl -sf http://host.docker.internal:3300/api/healthz
```

If both succeed, use `host.docker.internal:<port>` as your **one, universal** address — for
`GITEA_BASE_URL`, the `repositories.base_url` you pass to `repo connect --base-url`, and
`SCM_ALLOWED_HOST` — rather than `localhost`:

```bash
minicoder repo connect --project <id> --provider gitea --owner <owner> --name <name> \
  --base-url http://host.docker.internal:3300 --default-branch main --force --verify
```

If `host.docker.internal` doesn't resolve from your host shell (common on plain Linux without
Docker Desktop, where this hostname isn't automatically wired up), you're in a genuinely harder
case: host-side tools (`state doctor --check-scm`, `run-review`'s diff fetch, `run-merge-gate`,
`minicoder merge`) need one address for Gitea/GitLab, and the sandbox needs another (the Docker
bridge gateway IP, or a shared Docker network with Gitea's container) — `repositories.base_url` has
no way to express two different addresses for the same repository today. Bridging Gitea's container
onto `minicoder-coder-egress` and addressing it by container name/internal port is the more portable
fix in that case; this is real, unautomated setup work, not a one-line config change.

**A shell-exported value silently wins over `.env` when recreating these containers.** Docker
Compose always prefers a real environment variable already set in your shell over the same key's
value in an `.env` file — if you `export SCM_ALLOWED_HOST=...` (or `CODER_SANDBOX_HTTPS_PROXY`,
etc.) at any point while debugging, every later edit to `.env` is silently ignored for that
variable until you `unset` it, with no warning that this happened. Symptom: `docker exec
<proxy-container> cat /etc/tinyproxy/filter.txt` shows a stale or unexpected value even right
after editing `.env` and recreating the container. Always pass `--env-file .env` explicitly on
`docker compose` commands in this section to remove the ambiguity, and if something still looks
wrong, check `echo "[$SCM_ALLOWED_HOST]"` (and the equivalent for any other var you've touched) to
rule out a stray export before assuming the config file itself is wrong.

### 3.2 First-time setup

```bash
pnpm install
minicoder db migrate
minicoder db validate        # confirms every expected table/index exists
```

### 3.3 Environment variables at a glance

| Concern                      | Variable                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SCM stack (start script)     | `SCM_STACK`                                                                   | `gitea` (default) \| `gitlab` \| `github` \| `none` — same as `--scm=...`; picks which docker-compose infra 3.5 manages                                                                                                                                                                                                                                                                                                                                                  |
| Database                     | `DB_DIALECT`                                                                  | `sqlite` (default, quick setup) or `postgres` (more complex setup) — `--db=...` is the equivalent flag                                                                                                                                                                                                                                                                                                                                                                   |
| Database (SQLite)            | `DB_PATH`                                                                     | Defaults to `./minicoder.db`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Database (PostgreSQL)        | `DB_URL`                                                                      | Required when `DB_DIALECT=postgres`; auto-filled by `--db=postgres` if a local container is used                                                                                                                                                                                                                                                                                                                                                                         |
| API auth (server)            | `MINICODER_API_KEYS`                                                          | JSON array of `{key, id, role, actorKind, displayName?}`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| API auth (client/CLI/UI)     | `MINICODER_API_KEY`                                                           | One raw key from the array above                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| API location (client/CLI/UI) | `MINICODER_API_URL`                                                           | Defaults to `http://localhost:4000`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Gitea (default SCM)          | `GITEA_TOKEN` / `GITEA_BASE_URL`                                              | Used by `state doctor --check-scm` (Gitea-provider repos); auto-generated by the default `./scripts/start-minicoder.sh`. On Docker Desktop/WSL2, use `http://host.docker.internal:<port>`, not `localhost` — the coder sandbox runs in an isolated container that can't reach the host via `localhost` (§3.1.3)                                                                                                                                                          |
| GitHub                       | `GITHUB_TOKEN`                                                                | Used by the coder/reviewer adapters, `merge`, and `state doctor --check-scm` (GitHub-provider repos)                                                                                                                                                                                                                                                                                                                                                                     |
| GitLab                       | `GITLAB_TOKEN`                                                                | Used by `state doctor --check-scm` (GitLab-provider repos)                                                                                                                                                                                                                                                                                                                                                                                                               |
| Coder sandbox egress route   | `CODER_SANDBOX_HTTPS_PROXY`                                                   | **Effectively required for any self-hosted (Gitea/GitLab) or self-hosted-LLM setup**, despite being technically optional — unset, the sandbox container gets no proxy configuration at all and every git clone/push fails outright (`Could not resolve host`), regardless of `SCM_ALLOWED_HOST`. Set to `http://coder-sandbox-egress-proxy:8888` (the compose service name/port). See §3.1.3                                                                             |
| Coder sandbox egress         | `SCM_ALLOWED_HOST`                                                            | `host` or `host:port` (no scheme) of your Gitea/GitLab instance, added to the sandbox egress proxy's allow-list; an included `:port` is stripped automatically before matching, since tinyproxy's filter always compares against the bare hostname. Not needed for GitHub (already baked in). Has no effect unless `CODER_SANDBOX_HTTPS_PROXY` is also set, and requires an image rebuild (`docker compose up --build`) to pick up an `entrypoint.sh` change. See §3.1.3 |
| Coder sandbox (optional)     | `CODER_SANDBOX_IMAGE` / `CODER_SANDBOX_NETWORK` / `CODER_SANDBOX_DOCKER_HOST` | Override the sandbox image/network/Docker-socket-proxy address; sensible defaults match `infra/docker-compose.coder-sandbox.yml`                                                                                                                                                                                                                                                                                                                                         |
| GitHub webhooks              | `GITHUB_WEBHOOK_SECRET`                                                       | Required by both `minicoder github serve` and `minicoder api serve`                                                                                                                                                                                                                                                                                                                                                                                                      |
| GitHub webhooks (rotation)   | `GITHUB_WEBHOOK_SECRET_PREVIOUS`                                              | Optional, for secret rotation                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Gitea webhooks               | `GITEA_WEBHOOK_SECRET`                                                        | Required by `minicoder gitea serve`; optional for `minicoder api serve` (unset leaves `/webhooks/gitea` unmounted)                                                                                                                                                                                                                                                                                                                                                       |
| Gitea webhooks (rotation)    | `GITEA_WEBHOOK_SECRET_PREVIOUS`                                               | Optional, for secret rotation                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GitLab webhooks              | `GITLAB_WEBHOOK_SECRET`                                                       | Required by `minicoder gitlab serve`; optional for `minicoder api serve` (unset leaves `/webhooks/gitlab` unmounted)                                                                                                                                                                                                                                                                                                                                                     |
| GitLab webhooks (rotation)   | `GITLAB_WEBHOOK_SECRET_PREVIOUS`                                              | Optional, for secret rotation                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| LLM provider                 | `CODE_GEN_BASE_URL` / `CODE_GEN_API_KEY` / `CODE_GEN_MODEL`                   | Any OpenAI-compatible endpoint; shared by the coder, reviewer, planner, arbiter, and (by default) documentation adapters                                                                                                                                                                                                                                                                                                                                                 |
| Planner adapter timeout      | `PLANNER_TIMEOUT_MS`                                                          | Milliseconds; defaults to 300000 (5 min). Raise this if `run plan-generation`/`run backlog-generation` fails with `TimeoutError` on a large specification                                                                                                                                                                                                                                                                                                                |
| Observability (optional)     | `OTEL_EXPORTER_OTLP_ENDPOINT`                                                 | If unset, `observability export-otel` is a no-op                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Web UI                       | (none new)                                                                    | Reads the same `MINICODER_API_URL`/`MINICODER_API_KEY` as the CLI                                                                                                                                                                                                                                                                                                                                                                                                        |

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
./scripts/start-minicoder.sh                    # default: sqlite + local Gitea (docker compose)
./scripts/start-minicoder.sh --scm=github       # use a real GitHub project instead (3.1.1)
./scripts/start-minicoder.sh --scm=gitlab       # use a local GitLab CE instance instead (slow first
                                                  # boot — several minutes is normal for GitLab CE)
./scripts/start-minicoder.sh --scm=none         # skip SCM infra entirely
./scripts/start-minicoder.sh --db=postgres      # local PostgreSQL container instead of SQLite
./scripts/start-minicoder.sh --no-infra         # never touch Docker; use whatever's already
                                                  # configured (e.g. an externally-managed instance)
WORKER_COUNT=3 ./scripts/start-minicoder.sh      # scale to 3 task workers
START_WEB_UI=true ./scripts/start-minicoder.sh   # also start the Web UI (packages/web) on :3000
./scripts/start-minicoder.sh --webhook-only      # dev-only: minicoder github serve instead of api serve
./scripts/start-minicoder.sh --help              # full option/env-var reference
```

It loads a `.env` file from the repo root if present, brings up the docker-compose infra matching
`--scm`/`--db` (or `SCM_STACK`/`DB_DIALECT` in `.env`) unless `--no-infra` is passed — on first run
this includes bootstrapping a Gitea admin user and access token (or a GitLab root token) with no
manual web UI steps, saving the result back to `.env` so a later run reuses it. Without Docker
available, this step degrades to a warning rather than failing — set the matching `*_TOKEN`/
`*_BASE_URL`/`DB_URL` yourself to point at an externally-managed instance instead. It then runs
`minicoder db migrate` before starting anything, waits for `/healthz` before printing its summary,
and stops every process cleanly (no orphaned workers, no held ports) on Ctrl-C or `SIGTERM`. In
local development, unset `MINICODER_API_KEYS`/`GITHUB_WEBHOOK_SECRET` are filled in with
clearly-labeled dev-only placeholders (printed to the console so you know to use them); with
`APP_ENV=production` it refuses to start instead of inventing a production secret — set both for
real first. Logs for each process land in `logs/<process-name>.log`.

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
`GITHUB_WEBHOOK_SECRET`, your chosen SCM provider's token (`GITHUB_TOKEN`/`GITEA_TOKEN`/
`GITLAB_TOKEN`), and the `CODE_GEN_*` vars as container environment variables (never baked into the
image). With `APP_ENV=production` set, the script never brings up docker-compose SCM/DB infra on
its own regardless of `SCM_STACK`/`DB_DIALECT` — those are quickstart-only convenience; a
production deployment always supplies real, externally-managed credentials/endpoints directly.

In both cases, set `APP_ENV=production`, `DB_DIALECT=postgres` with a real `DB_URL` (SQLite is
local/single-node only — never on a network filesystem), and real values for
`MINICODER_API_KEYS`/`GITHUB_WEBHOOK_SECRET`/your SCM provider's token/`CODE_GEN_*` — the script
will refuse to start without the first two once `APP_ENV=production` is set.

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

### Step 3 — Generate, review, and approve the plan

Once clarification is `clarification_complete` (or the initial readiness assessment came back
`sufficient`), the plan and feature backlog don't exist yet on their own — generate them by
enqueueing the planner adapter (needs `CODE_GEN_BASE_URL`/`CODE_GEN_API_KEY`/`CODE_GEN_MODEL` set,
and a `PlannerAgentAdapter` — e.g. `GenericLLMPlannerAdapter` — already registered in the
`AdapterRegistry`; see the adapter registry bootstrap note in
[§3.5](#35-start-the-long-running-processes)):

```bash
minicoder plan --project <project>   # note the readiness assessment's id (assessmentId)
minicoder run plan-generation --project <project> --assessment <assessmentId> \
  --planner-adapter GenericLLMPlannerAdapter
minicoder status --project <project>   # poll until the generate-implementation-plan task succeeds
minicoder plan --project <project>     # view the generated plan's summary
minicoder plan --project <project> --plan <planId>   # full section-by-section content
```

Then generate the feature backlog from that plan the same way:

```bash
minicoder run backlog-generation --project <project> --plan <planId> \
  --planner-adapter GenericLLMPlannerAdapter
minicoder status --project <project>   # poll until generate-feature-backlog succeeds
minicoder features --project <project>          # the backlog, one row per feature
minicoder features --project <project> --full   # full descriptions and dependency lists
```

If a real specification is ambiguous, generation can surface a **blocking planning gap** even
after clarification completed sufficiently — this is a separate, later check from clarification's
own gaps, and `submit-for-approval` will refuse until every blocking gap is resolved:

```bash
minicoder plan resolve-gap --project <project> --assessment <assessmentId> --gap <gapId> \
  --resolution "<how you're resolving it>" --yes
```

If you'd rather hand-author the backlog instead of generating it, write a `backlog.md` and import
it:

```bash
minicoder plan import-backlog backlog.md --project <project> --plan <planId> --actor <you> --dry-run
minicoder plan import-backlog backlog.md --project <project> --plan <planId> --actor <you>
```

Submission for approval also requires the backlog to have passed validation:

```bash
minicoder plan validate-backlog --project <project> --plan <planId>
minicoder plan submit-for-approval --project <project> --plan <planId>
```

Approving and activating a plan requires `approver`/`admin` — this is where the plan moves
`draft → pending_approval → approved → activated_for_execution`, and every feature request becomes
a feature run at `approved_pending_execution`:

```bash
minicoder plan approve --project <project> --plan <planId> --yes
minicoder plan activate --project <project> --plan <planId> --yes
```

### Step 4 — Drive execution, and watch it work

**None of this happens on its own.** Every stage below is its own task-queue enqueue, and nothing
in this codebase automatically enqueues the next one when the previous one finishes — each hop is
either something you (or your own external scheduler/cron) trigger explicitly, or something a real
SCM webhook delivery triggers automatically (see below). Plan on driving one feature at a time
through this sequence:

```bash
# 1. Select the next eligible feature (dependency order, one-feature-at-a-time) and start coding.
minicoder run start-next-feature --project <project>
minicoder status --project <project>       # poll until the start-next-feature task succeeds
minicoder active --project <project>       # confirm execution state is now "coding"

# 2. Have the coder adapter write the code, push a branch, and open the PR.
minicoder run coder --project <project> --feature-run <featureRunId> --coder-adapter CodexCoderAdapter
minicoder status --project <project>       # poll until run-coder succeeds
minicoder active --project <project>       # confirm execution state is now "code_pushed", then
                                            # "pr_opened" once the PR is linked
```

**What happens next depends on whether a real SCM webhook is wired up** (see
[§3.1.1](#311-generating-github_token-and-github_webhook_secret-more-complex-setup-a-real-github-project)/
[§3.1.2](#312-connecting-a-gitea-or-gitlab-project)): a real webhook delivery (CI status change,
review submitted) drives `pr_opened → ci_running → under_review` automatically via the
webhook-triggered inbox handlers — this is the primary path (docs §3 decision #3), and once it
fires you don't need to do anything for this hop. If you don't have a real webhook wired (e.g.
local/dev use without tunneling one in), fake the events instead:

```bash
minicoder gitea simulate-check-passed --project <project> --pr-number <n>
minicoder gitea simulate-review-approved --project <project> --pr-number <n>
# (github/gitlab simulate-* if that's your provider — see §5.3)
```

**Known gap:** the scheduled `github-reconciliation` fallback task (meant to catch up on any
missed webhook delivery) has no CLI/API trigger of its own today — unlike every other Workflow
Layer task, there is no `minicoder run ...`/enqueue route for it. If you're not running a real
webhook receiver and don't want to hand-simulate every event, this is currently a real dead end,
not a misconfiguration on your end.

```bash
# 3. Once the PR reaches under_review, request an AI review.
minicoder run review --project <project> --feature-run <featureRunId> \
  --reviewer-adapter ClaudeReviewerAdapter
minicoder status --project <project>       # poll until run-review succeeds
minicoder active --project <project>       # blocking findings -> "changes_requested"/"fixing"
                                            # (loop back to step 2's `run coder` once fixed);
                                            # clean review -> stays at "under_review"

# 4. Once under_review with no blocking findings, recompute the merge gate.
minicoder run merge-gate --project <project> --feature-run <featureRunId>
minicoder status --project <project>       # poll until run-merge-gate succeeds
minicoder active --project <project>       # a passing gate -> "approved_by_policy"

# 5. An approver merges it (§4 Step 6 below has the full command).
minicoder merge merge-if-ready --feature-run <featureRunId> --project <project> --actor <you>
```

Once this feature reaches `merged` (or `skipped`), go back to step 1 (`run start-next-feature`) to
pick up the next one — it isn't self-rescheduling either. Watch overall progress with:

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

Repeat Step 4's sequence (`run start-next-feature` → `run coder` → CI/review observation →
`run review` → `run merge-gate` → `merge merge-if-ready`), one feature at a time, until every
feature request is `merged` or `skipped`. None of it repeats on its own — either drive it by hand
as above, or wire your own external scheduler/cron to call the same enqueue routes/CLI commands on
an interval (the same posture this manual's own [§5.13](#513-observability--minicoder-observability-export-otel-db)
already documents for `observability export-otel`).

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

minicoder clarification start --project <project> --session <sessionId>
  # clarification_required -> clarification_in_progress; expectedVersion fetched automatically

minicoder clarification complete --project <project> --session <sessionId>
  # clarification_in_progress -> clarification_complete, once every question in the round is
  # answered; expectedVersion fetched automatically

minicoder plan resolve-gap --project <project> --assessment <assessmentId> --gap <gapId> \
  --resolution "<how you're resolving it>" --yes
  # expectedVersion is fetched automatically from the readiness assessment

minicoder plan submit-for-approval --project <project> --plan <planId>

minicoder plan approve --project <project> --plan <planId> --yes [--notes "looks good"]
  # requires an approver/admin-role key

minicoder plan activate --project <project> --plan <planId> --yes
  # requires an approver/admin-role key

minicoder plan export --project <project> --plan <planId>
  # renders plan.md-equivalent markdown into a new artifact_exports row; no expectedVersion needed
  # (this operates on the fresh export row's own state, not the plan's)

minicoder plan export-backlog --project <project> --plan <planId>
  # renders backlog.md-equivalent markdown into a new artifact_exports row

minicoder budget approve-override --project <project> --policy <policyId> \
  --reason "approved extra spend for this sprint" --yes
  # requires an approver/admin-role key; --policy is the budget_policies row being overridden
```

Every one of these fetches its own `expectedVersion`/`expectedQuestionVersion` (an
optimistic-concurrency check) live before dispatching, where the underlying command actually needs
one, and mints a fresh `Idempotency-Key` per invocation by default — you never need to compute
either by hand. If a command times out or you lose its response before knowing whether it
succeeded, pass `--idempotency-key <key>` on the retry to reuse the exact same key instead of
risking a duplicate side effect from a second, differently-keyed submission.

If you need to call a command with no dedicated CLI wrapper yet, every registered handler remains
reachable directly via `POST /commands/:commandSlug` (`GET /commands` lists every slug currently
registered) — this needs `Authorization: Bearer <MINICODER_API_KEY>` and a client-chosen
`Idempotency-Key` header (any unique string per logical submission — reusing one replays the
original result rather than re-running the command). This escape hatch remains available for any
future command added to the registry before its own CLI wrapper lands — as of
[issue #81](https://github.com/jhoar/MiniCoder/issues/81)'s closure, every operation the manual
previously listed here now has one. Example, using the generic route directly for a command with
no wrapper yet:

```bash
curl -X POST "$MINICODER_API_URL/commands/<command-slug>" \
  -H "Authorization: Bearer $MINICODER_API_KEY" \
  -H "Idempotency-Key: <command-slug>-$(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"...": "..."}'
```

### 5.0.1 Task-enqueue commands — `minicoder run ...` / `minicoder design-doc request-run` (API)

Nine routes each enqueue a whole background task (readiness assessment, plan generation, backlog
generation, feature selection, coding, review, merge-gate recompute, or design-doc generation)
rather than executing synchronously. All require an **operator**-role (or above) API key; the CLI
mints the `Idempotency-Key` for you by default (or pass `--idempotency-key <key>` to reuse one
after a timeout/lost response) and prints `enqueued:<triggerdevRunId>` on success.

```bash
minicoder run readiness --project <project> --planner-adapter GenericLLMPlannerAdapter
  # enqueues planning-readiness-assessment against the project's most recently ingested spec

minicoder run plan-generation --project <project> --assessment <assessmentId> \
  --planner-adapter GenericLLMPlannerAdapter

minicoder run backlog-generation --project <project> --plan <planId> \
  --planner-adapter GenericLLMPlannerAdapter

minicoder run start-next-feature --project <project> [--feature-run <id>]
  # selects the next eligible feature (or the one named) and starts coding on it; not
  # self-rescheduling — call it again once the selected feature reaches merged/skipped to keep
  # the backlog moving (see §4 Step 4)

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
bootstrap note in [§3.5](#35-start-the-long-running-processes). Unlike the others,
`readiness`/`plan-generation`/`backlog-generation` can also enqueue with no assessment/plan/
features already present at all — that's the point: the underlying `planning-readiness-assessment`/
`generate-implementation-plan`/`generate-feature-backlog` tasks accept an empty payload plus an
adapter name and draft the content themselves, rather than requiring you to have already generated
or hand-authored it (see [§4 Step 3](#step-3--generate-review-and-approve-the-plan)). All three can
also take a long time on a large specification — if a run fails with a `TimeoutError`, raise
`PLANNER_TIMEOUT_MS` (milliseconds; defaults to 300000 / 5 minutes) before retrying.

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

### 5.3 SCM integration — `minicoder github/gitea/gitlab ...`

Each shipped SCM provider gets its own top-level command group (docs/06 §Phase 18) rather than one
generic `minicoder scm ... --provider <p>` — a project's `repositories.provider` decides which
provider's `ScmClient` the orchestrator actually talks to at runtime; these command groups are the
webhook receiver and dev-tooling for each.

| Subcommand                                                                                                                                                                                                                         | Purpose                                                                                                                                                                                                                                                                                                                                                            | Transport | Key flags                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github serve`                                                                                                                                                                                                                     | Run the real webhook receiver (`POST /webhooks/github`). Long-running; not environment-guarded — this is meant for production. Needs `GITHUB_WEBHOOK_SECRET`.                                                                                                                                                                                                      | process   | `--port` (default 3100), `--host` (default `0.0.0.0`)                                                                                                            |
| `github simulate-pr-opened` / `simulate-pr-closed` / `simulate-pr-merged` / `simulate-check-passed` / `simulate-check-failed` / `simulate-review-approved` / `simulate-review-changes-requested` / `simulate-branch-protection-ok` | Fake the corresponding GitHub event locally, without a real webhook. **Dev/test/CI only.**                                                                                                                                                                                                                                                                         | DB        | `--project <id>` (required), `--pr-number <n>` (required), plus event-specific optionals (`--merged`, `--check-name`, `--reviewer`, `--head-sha`, `--merge-sha`) |
| `gitea serve`                                                                                                                                                                                                                      | Run the real Gitea webhook receiver (`POST /webhooks/gitea`). Needs `GITEA_WEBHOOK_SECRET`.                                                                                                                                                                                                                                                                        | process   | `--port` (default 3101), `--host` (default `0.0.0.0`)                                                                                                            |
| `gitea simulate-pr-opened` / `simulate-pr-closed` / `simulate-pr-merged` / `simulate-check-passed` / `simulate-check-failed` / `simulate-review-approved` / `simulate-review-changes-requested`                                    | Fake the corresponding Gitea event locally. **Dev/test/CI only.** No `simulate-branch-protection-ok` — GitHub-specific dev-tooling with no real webhook event behind it even on GitHub's own side.                                                                                                                                                                 | DB        | Same shape as `github simulate-*`; `--reviewer` takes a Gitea login                                                                                              |
| `gitlab serve`                                                                                                                                                                                                                     | Run the real GitLab webhook receiver (`POST /webhooks/gitlab`). Needs `GITLAB_WEBHOOK_SECRET`.                                                                                                                                                                                                                                                                     | process   | `--port` (default 3102), `--host` (default `0.0.0.0`)                                                                                                            |
| `gitlab simulate-pr-opened` / `simulate-pr-closed` / `simulate-pr-merged` / `simulate-check-passed` / `simulate-check-failed` / `simulate-review-approved`                                                                         | Fake the corresponding GitLab event locally. **Dev/test/CI only.** No `simulate-review-changes-requested` (GitLab's webhooks never carry that condition — see §3.1.2's reconciliation-only recovery note) and no `simulate-branch-protection-ok` (same reason as Gitea). `--pr-number` here means the merge request's `iid`; `--reviewer` takes a GitLab username. | DB        | Same shape as `github simulate-*`                                                                                                                                |

### 5.4 Orchestrator API — `minicoder api serve` (process)

Starts the Fastify API everything else in this table depends on. `--port` (default 4000),
`--host` (default `0.0.0.0`). Stays running until stopped; doesn't close the DB connection. Also
mounts whichever SCM webhook routes have a configured secret: `/webhooks/github` (requires
`GITHUB_WEBHOOK_SECRET` — refuses to start without it, even on a deployment with no GitHub-provider
repository), `/webhooks/gitea` (mounted only if `GITEA_WEBHOOK_SECRET` is set), `/webhooks/gitlab`
(mounted only if `GITLAB_WEBHOOK_SECRET` is set).

### 5.5 Read/dashboard commands (all API transport, all support `--json`)

| Command                                                | Shows                                                                                                                                                                              | Key flags                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `status --project <id>`                                | Project + automation state, task-queue health, (if your key is operator+) doctor-check summary.                                                                                    | `--project` (required)                                                            |
| `plan --project <id>`                                  | The implementation plan and readiness assessment.                                                                                                                                  | `--project` (required)                                                            |
| `plan --project <id> --plan <planId>`                  | One plan's full title/summary/state and every section's full content.                                                                                                              | `--project` (required), `--plan`                                                  |
| `clarification --project <id> [--session <id>]`        | Clarification questions/answers, one session or the latest.                                                                                                                        | `--project` (required), `--session`                                               |
| `features --project <id> [--human-required] [--full]`  | The feature backlog, or (`--human-required`) only items parked at `human_required`, or (`--full`) untruncated descriptions and `depends_on_fr_ids` instead of the truncated table. | `--project` (required), `--human-required`, `--full`, `--cursor`, `--limit`       |
| `active --project <id>`                                | The one feature currently in flight and its linked PR/CI status.                                                                                                                   | `--project` (required)                                                            |
| `runs [--project <id>] [--feature-run <id>]`           | Agent run history.                                                                                                                                                                 | `--project`, `--feature-run`, `--cursor`, `--limit`                               |
| `runs --timeline <featureRunId>`                       | One feature's full merged chronological history (events, runs, findings, PR, cost, approvals).                                                                                     | positional-ish `--timeline <id>`                                                  |
| `findings --feature-run <id>`                          | Review findings for one feature run.                                                                                                                                               | `--feature-run` (required), `--cursor`, `--limit`                                 |
| `disagreements [--feature-run <id>] [--state <state>]` | Coder/reviewer disagreements (global if unfiltered).                                                                                                                               | `--feature-run`, `--state` (`open`/`escalated`/`resolved`), `--cursor`, `--limit` |
| `costs --project <id>`                                 | Raw cost records + active budget policies.                                                                                                                                         | `--project` (required)                                                            |
| `costs --project <id> --report [--window-days <n>]`    | Aggregate spend by scope/feature/provider/model/role.                                                                                                                              | `--report`, `--window-days`                                                       |
| `artifacts --project <id>`                             | Generated artifact exports (plan.md, backlog.md, final-design-document.md, ...).                                                                                                   | `--project` (required), `--cursor`, `--limit`                                     |
| `adapters [--adapter <id>]`                            | Registered AI adapters and their configurations (read-only).                                                                                                                       | `--adapter`                                                                       |

### 5.6 Plan and backlog — `minicoder plan ...`

| Subcommand              | Transport | Purpose                                                                                                                                                                                                                     | Key flags                                                                                                                             |
| ----------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| _(bare)_                | API       | Default view: plan + readiness, or (with `--plan`) one plan's full title/summary/state and section content.                                                                                                                 | `--project` (required), `--plan`                                                                                                      |
| `import-backlog <file>` | DB        | Parse, validate, preview, and (unless `--dry-run`) import a hand-written `backlog.md`.                                                                                                                                      | positional file, `--project` (required), `--plan` (required), `--actor` (required), `--actor-role` (default `approver`), `--dry-run`  |
| `validate-backlog`      | DB        | Validate the current backlog against its own current version — required before `submit-for-approval` will accept it. Dispatches as a system actor (bypasses the generic-dispatch route's own system-actorKind restriction). | `--project` (required), `--plan` (required)                                                                                           |
| `resolve-gap`           | API       | Resolve one blocking `planning_gaps` row (from either clarification or a later plan/backlog generation pass) — required before `submit-for-approval` will accept it if any gap is still unresolved.                         | `--project` (required), `--assessment <id>` (required), `--gap <id>` (required), `--resolution <text>` (required), `--yes` (required) |

### 5.7 Design document — `minicoder design-doc ...` (API)

| Subcommand         | Transitions                                                                                                                                                                                                                                                                     | Role needed | Key flags                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _(bare)_           | — (read-only)                                                                                                                                                                                                                                                                   | any         | `--project` (required), `--document <id>`                                                                                                                    |
| `generate`         | `implementation_complete → design_document_generating`                                                                                                                                                                                                                          | operator+   | `--project`, `--yes` (required)                                                                                                                              |
| `regenerate`       | `design_document_revision_requested → design_document_generating`                                                                                                                                                                                                               | operator+   | `--project`, `--yes` (required)                                                                                                                              |
| `request-revision` | `design_document_ready_for_review → design_document_revision_requested`                                                                                                                                                                                                         | approver+   | `--project`, `--document` (required), `--notes`, `--yes` (required)                                                                                          |
| `approve`          | `design_document_ready_for_review → design_document_approved`                                                                                                                                                                                                                   | approver+   | `--project`, `--document` (required), `--notes`, `--yes` (required)                                                                                          |
| `request-run`      | Enqueues the drafting task (calls the `DocumentationAgentAdapter`, exports `final-design-document.md`).                                                                                                                                                                         | operator+   | `--project`, `--documentation-adapter <name>` (required; must already be registered in `AdapterRegistry` — see [§3.5](#35-start-the-long-running-processes)) |
| `repair-binding`   | Backfills a NULL `artifact_exports.design_document_id` binding on a pre-migration-0014 (or manually-inserted) design-document artifact export — issue #71's recovery path for a row `export`/`approve` would otherwise reject forever. Never rebinds an already-bound artifact. | operator+   | `--project`, `--artifact <id>` (required), `--document <id>` (required; must belong to the project), `--yes` (required)                                      |

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
Confirm `minicoder tasks worker` is actually running — nothing advances without it. If
`Active feature run` has been `(none)` since activation (or since the last feature merged/skipped),
that's expected — `start-next-feature` doesn't run on its own; enqueue it:
`minicoder run start-next-feature --project <project>` (see [§4 Step 4](#step-4--kick-off-execution-and-watch-it-work)).

**`generate-implementation-plan`/`generate-feature-backlog` failed with `TimeoutError`.**
Check with `minicoder trigger inspect-run <runId>`. The default planner-adapter HTTP timeout
(`PLANNER_TIMEOUT_MS`, 5 minutes) can be too short for a large specification against a slower LLM
endpoint — raise it (e.g. `export PLANNER_TIMEOUT_MS=1800000` for 30 minutes) and re-run
`minicoder run plan-generation`/`minicoder run backlog-generation`.

**`submit-for-approval` fails with `409 backlog-not-validated` or `409 unresolved-blocking-gaps`.**
Both are real preconditions, not bugs: run `minicoder plan validate-backlog --project <project>
--plan <planId>` first, and if validation (or an earlier clarification/generation pass) left any
blocking `planning_gaps` row unresolved, resolve each one with `minicoder plan resolve-gap` before
retrying `submit-for-approval` — see [§4 Step 3](#step-3--generate-review-and-approve-the-plan).

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

**`minicoder api serve` refuses to start on a Gitea/GitLab-only deployment, complaining about
`GITHUB_WEBHOOK_SECRET`.** `minicoder api serve` currently requires `GITHUB_WEBHOOK_SECRET`
unconditionally to start at all, even when every project's repository is on Gitea or GitLab and
`/webhooks/github` will never receive a delivery — this is a known, real asymmetry versus
`GITEA_WEBHOOK_SECRET`/`GITLAB_WEBHOOK_SECRET`, which are genuinely optional (each just leaves its
own route unmounted if unset). The workaround today: set `GITHUB_WEBHOOK_SECRET` to any random
value (`openssl rand -hex 32`) even if you never register a GitHub webhook — `/webhooks/github`
being mounted but never called is harmless. Making `GITHUB_WEBHOOK_SECRET` genuinely optional, to
match Gitea/GitLab's treatment, is tracked as real follow-up work, not fixed as part of the Generic
SCM Interface plan's Stage 6 rollout (docs/06 §Phase 18) — see that stage's completion notes.

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
