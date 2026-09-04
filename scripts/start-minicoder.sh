#!/usr/bin/env bash
#
# start-minicoder.sh — start every MiniCoder long-running process with one command.
#
# MiniCoder has exactly two long-running processes in normal operation:
#   1. `minicoder api serve`   — the Orchestrator API. This single process also mounts the
#                                 GitHub/Gitea/GitLab webhook routes (/webhooks/*), so it is both
#                                 the API surface AND the webhook receiver (see
#                                 packages/api/src/server.ts and CLAUDE.md's "Orchestrator API
#                                 Operational Constraints"). A separate `minicoder github/gitea/
#                                 gitlab serve` process is NOT needed alongside it — those commands
#                                 exist only for the narrow case of running a webhook-only receiver
#                                 without the rest of the API (see the --webhook-only flag below).
#   2. `minicoder tasks worker` — polls the DB-backed task_queue and executes claimed tasks
#                                 (run-coder, run-review, run-merge-gate, run-design-doc, etc).
#                                 This is horizontally scalable: run more workers against the
#                                 same database to increase throughput (CLAUDE.md's "Task Worker
#                                 Operational Constraints" — there is no separate deployment-tier
#                                 axis, just "run more `minicoder tasks worker` processes").
#
# Everything else (`minicoder plan`, `minicoder human ...`, `minicoder merge merge-if-ready`,
# the Text UI read commands, etc.) is one-shot CLI usage against the running API — it doesn't
# belong in a process supervisor.
#
# Default configuration — SQLite + a local Gitea instance (docker-compose-managed) — is chosen so
# a fresh checkout is usable quickly with no external accounts to sign up for. PostgreSQL, GitHub,
# and GitLab remain fully supported for more complex/hosted setups; opt in with --db=postgres /
# --scm=github / --scm=gitlab (see below).
#
# What this script does, in order:
#   1. Loads .env (if present) and fills in sensible local-dev defaults for anything unset.
#   2. Refuses to fabricate secrets/defaults when APP_ENV=production (fail loud, not silently).
#   3. Unless --no-infra: brings up the docker-compose stack(s) matching --scm/--db (or the
#      SCM_STACK/DB_DIALECT env vars), waits for their healthchecks, and — on first run only —
#      bootstraps an admin user/access token for Gitea/GitLab so a real GITEA_TOKEN/GITLAB_TOKEN
#      exists without any manual web UI clicking. Bootstrapped values are saved to .env so a later
#      run reuses them instead of re-creating anything. If Docker isn't available, this step is
#      skipped with a warning rather than failing the whole script — you can still point at an
#      externally-managed instance by setting the matching *_TOKEN/*_BASE_URL/DB_URL yourself.
#   4. Runs `minicoder db migrate` so the schema is current before anything else starts.
#   5. Starts one `minicoder api serve` process.
#   6. Starts $WORKER_COUNT `minicoder tasks worker` processes (default 1).
#   7. Optionally starts the Next.js Web UI (`packages/web`) if START_WEB_UI=true.
#   8. Waits for the API's /healthz to respond, prints a summary, then waits on all children —
#      Ctrl-C (or `kill <pid>`) stops every child cleanly via a trap.
#
# Usage:
#   ./scripts/start-minicoder.sh                  # default: sqlite + local Gitea (docker compose)
#   ./scripts/start-minicoder.sh --scm=github     # use GitHub instead — no Gitea container brought
#                                                   # up; configure GITHUB_TOKEN/GITHUB_WEBHOOK_SECRET
#                                                   # yourself (see USER-MANUAL.md §3.1.1)
#   ./scripts/start-minicoder.sh --scm=gitlab     # use a local GitLab CE instance instead of Gitea
#                                                   # (docker compose; slow first boot — several
#                                                   # minutes is normal for GitLab CE)
#   ./scripts/start-minicoder.sh --scm=none       # skip SCM infra entirely (e.g. CI, unit-test-only
#                                                   # usage, or a deployment with no PR flow yet)
#   ./scripts/start-minicoder.sh --db=postgres    # bring up a local PostgreSQL container instead of
#                                                   # SQLite (or set DB_URL yourself to point at an
#                                                   # existing instance and this script won't touch it)
#   ./scripts/start-minicoder.sh --no-infra       # never touch Docker — use whatever *_TOKEN/
#                                                   # *_BASE_URL/DB_URL is already configured
#   WORKER_COUNT=3 ./scripts/start-minicoder.sh    # sqlite+gitea, 3 workers
#   START_WEB_UI=true ./scripts/start-minicoder.sh # also start the Web UI on :3000
#   ./scripts/start-minicoder.sh --webhook-only    # run `github serve` instead of `api serve`
#                                                   # (dev-only: skips MINICODER_API_KEYS entirely;
#                                                   # only meaningful with --scm=github)
#
# All configuration is via environment variables / a .env file in the repo root — see the
# "defaults" section below for the full list and what each one controls. SCM_STACK (gitea |
# gitlab | github | none, default gitea) and DB_DIALECT (sqlite | postgres, default sqlite) can be
# set either as env vars/.env or via the --scm/--db flags above (the flag wins if both are given).

set -euo pipefail
set -m   # enable job control so each backgrounded process gets its own process group — required
         # so cleanup() below can signal a whole pnpm-exec-tsx process tree at once (see cleanup())
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # always run from the repo root, regardless of caller cwd

# ---------------------------------------------------------------------------
# 0. Parse flags
# ---------------------------------------------------------------------------
WEBHOOK_ONLY=false
NO_INFRA=false
SCM_STACK_FLAG=""
DB_DIALECT_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --webhook-only) WEBHOOK_ONLY=true ;;
    --no-infra) NO_INFRA=true ;;
    --scm=*) SCM_STACK_FLAG="${arg#--scm=}" ;;
    --db=*) DB_DIALECT_FLAG="${arg#--db=}" ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (see --help)" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# 1. Load .env (plain KEY=VALUE lines, no interpolation) if present.
# ---------------------------------------------------------------------------
REPO_ROOT="$(pwd)"   # absolute — we already cd'd to the repo root above
ENV_FILE="${REPO_ROOT}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ENV_FILE"
  set +a
fi

APP_ENV="${APP_ENV:-development}"
IS_PRODUCTION=false
[ "$APP_ENV" = "production" ] || [ "${NODE_ENV:-}" = "production" ] && IS_PRODUCTION=true

# --- Which SCM/DB stacks to use (flag > env var > default) -------------------
SCM_STACK="${SCM_STACK_FLAG:-${SCM_STACK:-gitea}}"
DB_DIALECT="${DB_DIALECT_FLAG:-${DB_DIALECT:-sqlite}}"
export SCM_STACK DB_DIALECT

case "$SCM_STACK" in
  gitea|gitlab|github|none) ;;
  *) echo "ERROR: --scm must be one of gitea|gitlab|github|none (got: $SCM_STACK)" >&2; exit 1 ;;
esac
case "$DB_DIALECT" in
  sqlite|postgres) ;;
  *) echo "ERROR: --db must be one of sqlite|postgres (got: $DB_DIALECT)" >&2; exit 1 ;;
esac

# ---------------------------------------------------------------------------
# 2. Sensible defaults for local development only. In production every one of
#    these must already be set for real (in .env, your process manager, or your
#    secrets store) — this script never invents a production secret.
# ---------------------------------------------------------------------------
mkdir -p "${REPO_ROOT}/data" "${REPO_ROOT}/logs"

# env_file_has/persist_env_var: idempotent .env writer used by the infra-bootstrap functions below
# — a value is only ever appended once, so re-running this script reuses whatever was generated
# the first time instead of recreating a Gitea admin user/token or a Postgres volume every run.
env_file_has() { [ -f "$ENV_FILE" ] && grep -qE "^$1=" "$ENV_FILE" 2>/dev/null; }
persist_env_var() {
  local name="$1" value="$2"
  if ! env_file_has "$name"; then
    [ -f "$ENV_FILE" ] || : > "$ENV_FILE"
    printf '%s=%s\n' "$name" "$value" >> "$ENV_FILE"
    echo "    (saved ${name} to .env)"
  fi
  export "${name}=${value}"
}

have_docker() {
  # `docker info` alone only proves the daemon is reachable — it says nothing about whether the
  # `docker compose` CLI plugin is installed. On a host with a working daemon but no compose
  # plugin (e.g. an old Docker CLI predating Compose V2), `docker compose -f ...` doesn't fail
  # with a clean "unknown command" — Docker's flag parser instead misreads the dropped `compose`
  # token and reports a confusing "unknown shorthand flag: 'f' in -f", masking the real problem
  # and skipping this function's own documented graceful-degradation path entirely. Checking
  # `docker compose version` here closes that gap.
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

wait_for_health() {
  # $1 container name, $2 max attempts, $3 seconds between attempts
  local name="$1" attempts="$2" sleep_s="$3" status
  for i in $(seq 1 "$attempts"); do
    status="$(docker inspect --format='{{.State.Health.Status}}' "$name" 2>/dev/null || echo starting)"
    if [ "$status" = "healthy" ]; then
      echo "==> ${name} healthy after $(( i * sleep_s ))s"
      return 0
    fi
    sleep "$sleep_s"
  done
  echo "WARNING: ${name} did not report healthy in time — continuing anyway; check 'docker logs ${name}'." >&2
  return 1
}

# --- SCM infra: Gitea (default) ------------------------------------------------
bootstrap_gitea() {
  local container="minicoder-gitea-fixture"
  echo "==> Bringing up Gitea (docker compose -f infra/docker-compose.gitea.yml up -d)"
  docker compose -f infra/docker-compose.gitea.yml up -d
  wait_for_health "$container" 30 2 || true

  persist_env_var GITEA_BASE_URL "${GITEA_BASE_URL:-http://localhost:3300}"

  if [ -n "${GITEA_TOKEN:-}" ]; then
    echo "==> GITEA_TOKEN already set — reusing it (skipping admin/token bootstrap)."
    return 0
  fi

  echo "==> Bootstrapping a Gitea admin user + access token (first run only)"
  local create_log="${REPO_ROOT}/logs/gitea-bootstrap-create.log"
  local token_log="${REPO_ROOT}/logs/gitea-bootstrap-token.log"
  if ! docker exec -u git "$container" gitea admin user create \
      --config /data/gitea/conf/app.ini \
      --username minicoder --password "$(openssl rand -base64 24)" \
      --email minicoder@example.local --admin --must-change-password=false \
      > "$create_log" 2>&1; then
    if ! grep -qi "already exists" "$create_log"; then
      echo "WARNING: could not create a Gitea admin user automatically (see ${create_log})." >&2
      echo "         Configure GITEA_TOKEN manually: open ${GITEA_BASE_URL:-http://localhost:3300}," >&2
      echo "         create an account, then Settings -> Applications -> Generate New Token." >&2
      return 0
    fi
  fi

  local token
  if ! token="$(docker exec -u git "$container" gitea admin user generate-access-token \
      --config /data/gitea/conf/app.ini \
      --username minicoder --token-name "minicoder-quickstart-$(date +%s)" \
      --scopes 'write:repository,write:user,write:issue' --raw 2>"$token_log")"; then
    echo "WARNING: could not generate a Gitea access token automatically (see ${token_log})." >&2
    return 0
  fi

  persist_env_var GITEA_TOKEN "$token"
  echo "==> Gitea ready: ${GITEA_BASE_URL:-http://localhost:3300} (admin user: minicoder / see logs/gitea.log)"
}

# --- SCM infra: GitLab (opt-in, --scm=gitlab) ----------------------------------
bootstrap_gitlab() {
  local container="minicoder-gitlab-fixture"
  echo "==> Bringing up GitLab CE (docker compose -f infra/docker-compose.gitlab.yml up -d)"
  echo "    NOTE: GitLab CE is a full Rails monolith — first boot commonly takes several minutes."
  docker compose -f infra/docker-compose.gitlab.yml up -d
  wait_for_health "$container" 90 10 || true

  persist_env_var GITLAB_BASE_URL "${GITLAB_BASE_URL:-http://localhost:3400}"

  if [ -n "${GITLAB_TOKEN:-}" ]; then
    echo "==> GITLAB_TOKEN already set — reusing it (skipping root-token bootstrap)."
    return 0
  fi

  echo "==> Bootstrapping a GitLab root access token (first run only)"
  local token_log="${REPO_ROOT}/logs/gitlab-bootstrap-token.log"
  local token
  token="$(docker exec "$container" gitlab-rails runner "
    t = User.find_by_username('root').personal_access_tokens.create!(
      scopes: ['api'], name: 'minicoder-quickstart', expires_at: 365.days.from_now)
    plaintext = SecureRandom.hex(20)
    t.set_token(plaintext)
    t.save!
    puts plaintext
  " 2>"$token_log" | tail -1)" || true

  if [ -z "$token" ]; then
    echo "WARNING: could not generate a GitLab access token automatically (see ${token_log})." >&2
    echo "         Configure GITLAB_TOKEN manually: open ${GITLAB_BASE_URL:-http://localhost:3400}" >&2
    echo "         and create a personal access token with the 'api' scope." >&2
    return 0
  fi

  persist_env_var GITLAB_TOKEN "$token"
  echo "==> GitLab ready: ${GITLAB_BASE_URL:-http://localhost:3400} (root token generated)"
}

# --- DB infra: PostgreSQL (opt-in, --db=postgres) ------------------------------
bootstrap_postgres() {
  local container="minicoder-postgres"
  echo "==> Bringing up PostgreSQL (docker compose -f infra/docker-compose.postgres.yml up -d)"
  docker compose -f infra/docker-compose.postgres.yml up -d
  wait_for_health "$container" 30 2 || true
  persist_env_var DB_URL "${DB_URL:-postgres://minicoder:minicoder@localhost:5432/minicoder}"
}

# ---------------------------------------------------------------------------
# 3. Bring up docker-compose infra for the selected SCM_STACK/DB_DIALECT,
#    unless --no-infra was passed. Never fatal — a missing Docker daemon or a
#    failed bootstrap step degrades to "configure it yourself" warnings so the
#    rest of the script (and any externally-managed instance) still works.
# ---------------------------------------------------------------------------
if [ "$IS_PRODUCTION" = true ]; then
  echo "==> APP_ENV=production: never auto-provisioning docker-compose SCM/DB infra — supply real,"
  echo "    externally-managed *_TOKEN/*_BASE_URL/DB_URL yourself (these are quickstart-only)."
elif [ "$NO_INFRA" = true ]; then
  echo "==> --no-infra: not touching Docker; using whatever *_TOKEN/*_BASE_URL/DB_URL is already configured."
elif ! have_docker; then
  if [ "$SCM_STACK" != "github" ] && [ "$SCM_STACK" != "none" ]; then
    SCM_STACK_UPPER="$(printf '%s' "$SCM_STACK" | tr '[:lower:]' '[:upper:]')"
    echo "NOTE: Docker not available/running, or the 'docker compose' plugin isn't installed —" >&2
    echo "      skipping local ${SCM_STACK} infra." >&2
    echo "      Set ${SCM_STACK_UPPER}_TOKEN (and ${SCM_STACK_UPPER}_BASE_URL) yourself, or install" >&2
    echo "      Docker (with the compose plugin: 'docker compose version' should succeed) and" >&2
    echo "      re-run, to use the default zero-touch local ${SCM_STACK} setup." >&2
  fi
  if [ "$DB_DIALECT" = "postgres" ] && [ -z "${DB_URL:-}" ]; then
    echo "NOTE: Docker not available/running and DB_URL is unset — set DB_URL yourself to point at" >&2
    echo "      an existing PostgreSQL instance." >&2
  fi
else
  case "$SCM_STACK" in
    gitea) bootstrap_gitea ;;
    gitlab) bootstrap_gitlab ;;
    github|none) ;;   # no local infra to manage for these
  esac
  if [ "$DB_DIALECT" = "postgres" ]; then
    bootstrap_postgres
  fi
fi

# --- Database (packages/triggerdev/src/db.ts) --------------------------------
# Must be an ABSOLUTE path: every `minicoder` invocation below runs via
# `pnpm --filter @minicoder/cli exec ...`, which executes with cwd=packages/cli, not the repo
# root — a relative DB_PATH would silently resolve (and create the DB file) under
# packages/cli/ instead of here.
export DB_PATH="${DB_PATH:-${REPO_ROOT}/data/minicoder.db}"   # sqlite only
if [ "$DB_DIALECT" = "postgres" ] && [ -z "${DB_URL:-}" ]; then
  echo "ERROR: DB_DIALECT=postgres but DB_URL is not set (and could not be auto-provisioned)." >&2
  echo "       Set DB_URL, or bring up ${REPO_ROOT}/infra/docker-compose.postgres.yml and re-run." >&2
  exit 1
fi

# --- Orchestrator API auth (packages/api/src/auth/api-key-provider.ts) -------
# MINICODER_API_KEYS is a JSON array of {key, id, role, actorKind, displayName?}.
# role is one of viewer|operator|approver|admin; actorKind is human|system.
if [ -z "${MINICODER_API_KEYS:-}" ]; then
  if [ "$IS_PRODUCTION" = true ]; then
    echo "ERROR: MINICODER_API_KEYS is required and must be set explicitly in production." >&2
    echo "       Refusing to generate a default admin key. Set it in .env or your secrets store." >&2
    exit 1
  fi
  DEV_API_KEY="dev-local-admin-key"
  export MINICODER_API_KEYS="[{\"key\":\"${DEV_API_KEY}\",\"id\":\"local-admin\",\"role\":\"admin\",\"actorKind\":\"human\",\"displayName\":\"Local Dev Admin\"}]"
  echo "NOTE: MINICODER_API_KEYS not set — generated a dev-only admin key: ${DEV_API_KEY}"
  echo "      Use it as: export MINICODER_API_KEY=${DEV_API_KEY}"
fi

# --- Webhook receiver secret --------------------------------------------------
# `minicoder api serve` currently requires GITHUB_WEBHOOK_SECRET unconditionally, even on a
# Gitea/GitLab-only deployment (a known, documented asymmetry — see USER-MANUAL.md §3.1.2's
# "Running the receiver" note) — so a dev placeholder is always generated here regardless of
# SCM_STACK. GITEA_WEBHOOK_SECRET/GITLAB_WEBHOOK_SECRET are genuinely optional (unset simply
# leaves that provider's webhook route unmounted); a placeholder is still generated for whichever
# provider is selected so the route is available immediately if you wire up a real webhook later.
if [ -z "${GITHUB_WEBHOOK_SECRET:-}" ]; then
  if [ "$IS_PRODUCTION" = true ]; then
    echo "ERROR: GITHUB_WEBHOOK_SECRET is required and must be set explicitly in production." >&2
    exit 1
  fi
  export GITHUB_WEBHOOK_SECRET="dev-local-webhook-secret"
  echo "NOTE: GITHUB_WEBHOOK_SECRET not set — using a dev-only placeholder."
  echo "      Real GitHub webhook deliveries will fail HMAC verification until you set a real one."
fi
# GITHUB_WEBHOOK_SECRET_PREVIOUS is optional — only needed while rotating secrets.

if [ "$SCM_STACK" = "gitea" ] && [ -z "${GITEA_WEBHOOK_SECRET:-}" ] && [ "$IS_PRODUCTION" != true ]; then
  export GITEA_WEBHOOK_SECRET="dev-local-gitea-webhook-secret"
fi
if [ "$SCM_STACK" = "gitlab" ] && [ -z "${GITLAB_WEBHOOK_SECRET:-}" ] && [ "$IS_PRODUCTION" != true ]; then
  export GITLAB_WEBHOOK_SECRET="dev-local-gitlab-webhook-secret"
fi

# --- Ports / hosts -------------------------------------------------------------
export API_PORT="${API_PORT:-4000}"
export API_HOST="${API_HOST:-0.0.0.0}"
export GITHUB_SERVE_PORT="${GITHUB_SERVE_PORT:-3100}"
export WEB_UI_PORT="${WEB_UI_PORT:-3000}"

# --- Task worker tuning (packages/cli/src/commands/tasks.ts defaults shown) ---
export TASK_WORKER_POLL_INTERVAL_MS="${TASK_WORKER_POLL_INTERVAL_MS:-2000}"
export TASK_WORKER_BATCH_SIZE="${TASK_WORKER_BATCH_SIZE:-10}"
export TASK_WORKER_STALE_CLAIM_MS="${TASK_WORKER_STALE_CLAIM_MS:-300000}"
WORKER_COUNT="${WORKER_COUNT:-1}"

# --- Agent adapters (only required once you actually run coder/reviewer/design-doc
#     tasks — the API and worker will start fine without these, individual tasks
#     will just fail fast with an actionable "not configured" error until set) ---
# export GITHUB_TOKEN=...                # GitHub API token for PR creation, reconciliation
#                                         # (GITEA_TOKEN/GITLAB_TOKEN for those providers — the
#                                         # default gitea stack above generates GITEA_TOKEN for you)
# export CODE_GEN_BASE_URL=...           # OpenAI-compatible LLM endpoint for Coder/Reviewer/etc.
# export CODE_GEN_API_KEY=...
# export CODE_GEN_MODEL=...

# --- Web UI (packages/web) — server-side only, never sent to the browser ------
export MINICODER_API_URL="${MINICODER_API_URL:-http://localhost:${API_PORT}}"
# export MINICODER_API_KEY=...           # must match one entry in MINICODER_API_KEYS above

START_WEB_UI="${START_WEB_UI:-false}"

# ---------------------------------------------------------------------------
# 4. Preflight
# ---------------------------------------------------------------------------
command -v pnpm >/dev/null 2>&1 || { echo "ERROR: pnpm not found on PATH (run: corepack enable)" >&2; exit 1; }

echo "==> Applying pending migrations (minicoder db migrate)"
pnpm --filter @minicoder/cli exec tsx src/index.ts db migrate

# ---------------------------------------------------------------------------
# 5. Start processes, tracking PIDs so the trap below can stop them all.
# ---------------------------------------------------------------------------
PIDS=()
LOG_DIR="${REPO_ROOT}/logs"

start_bg() {
  local name="$1"; shift
  echo "==> Starting ${name}: $*"
  "$@" > "${LOG_DIR}/${name}.log" 2>&1 &
  PIDS+=("$!")
  echo "    ${name} pid=$! log=${LOG_DIR}/${name}.log"
}

cleanup() {
  echo ""
  echo "==> Shutting down (sending SIGTERM to ${#PIDS[@]} process(es))..."
  for pid in "${PIDS[@]}"; do
    # Negative pid = signal the whole process group, not just the immediate child — each
    # `minicoder ...` invocation is really `pnpm exec tsx ...` (2-3 process layers deep), and
    # `set -m` above put each one in its own group, so this is what actually reaches the real
    # node/tsx process instead of just the outer pnpm wrapper.
    kill -TERM -- "-${pid}" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "==> All processes stopped."
}
trap cleanup INT TERM

MINICODER="pnpm --filter @minicoder/cli exec tsx src/index.ts"

if [ "$WEBHOOK_ONLY" = true ]; then
  # Dev-only lightweight path: webhook receiver alone, no Orchestrator API, no API-key auth.
  start_bg "github-serve" $MINICODER github serve --port "$GITHUB_SERVE_PORT" --host "$API_HOST"
else
  start_bg "api-serve" $MINICODER api serve --port "$API_PORT" --host "$API_HOST"
fi

for i in $(seq 1 "$WORKER_COUNT"); do
  start_bg "tasks-worker-${i}" $MINICODER tasks worker
done

if [ "$START_WEB_UI" = "true" ]; then
  start_bg "web-ui" pnpm --filter @minicoder/web dev -- -p "$WEB_UI_PORT"
fi

# ---------------------------------------------------------------------------
# 6. Wait for the API to come up, then print a summary.
# ---------------------------------------------------------------------------
if [ "$WEBHOOK_ONLY" != true ]; then
  echo "==> Waiting for Orchestrator API to become healthy..."
  for _ in $(seq 1 30); do
    if curl -fsS "http://localhost:${API_PORT}/healthz" >/dev/null 2>&1; then
      echo "==> Orchestrator API is up: http://localhost:${API_PORT}"
      break
    fi
    sleep 1
  done
fi

cat <<SUMMARY

MiniCoder is running (APP_ENV=${APP_ENV}, DB_DIALECT=${DB_DIALECT}, SCM_STACK=${SCM_STACK}).
  Orchestrator API : http://localhost:${API_PORT}  (also serves /webhooks/*)
  Task workers     : ${WORKER_COUNT} process(es)
  Web UI           : $( [ "$START_WEB_UI" = "true" ] && echo "http://localhost:${WEB_UI_PORT}" || echo "not started (START_WEB_UI=true to enable)" )
  SCM              : $(case "$SCM_STACK" in
                          gitea) echo "Gitea at ${GITEA_BASE_URL:-http://localhost:3300} (GITEA_TOKEN $( [ -n "${GITEA_TOKEN:-}" ] && echo set || echo "NOT SET" ))" ;;
                          gitlab) echo "GitLab at ${GITLAB_BASE_URL:-http://localhost:3400} (GITLAB_TOKEN $( [ -n "${GITLAB_TOKEN:-}" ] && echo set || echo "NOT SET" ))" ;;
                          github) echo "GitHub (GITHUB_TOKEN $( [ -n "${GITHUB_TOKEN:-}" ] && echo set || echo "NOT SET" ))" ;;
                          none) echo "none configured" ;;
                        esac)
  Logs             : ${LOG_DIR}/*.log

Press Ctrl-C to stop everything.
SUMMARY

wait
