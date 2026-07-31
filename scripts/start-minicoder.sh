#!/usr/bin/env bash
#
# start-minicoder.sh — start every MiniCoder long-running process with one command.
#
# MiniCoder has exactly two long-running processes in normal operation:
#   1. `minicoder api serve`   — the Orchestrator API. This single process also mounts the
#                                 GitHub webhook route (/webhooks/*), so it is both the API
#                                 surface AND the webhook receiver (see packages/api/src/server.ts
#                                 and CLAUDE.md's "Orchestrator API Operational Constraints").
#                                 A separate `minicoder github serve` process is NOT needed
#                                 alongside it — that command exists only for the narrow case of
#                                 running a webhook-only receiver without the rest of the API
#                                 (see the --webhook-only flag below).
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
# What this script does, in order:
#   1. Loads .env (if present) and fills in sensible local-dev defaults for anything unset.
#   2. Refuses to fabricate secrets/defaults when APP_ENV=production (fail loud, not silently).
#   3. Runs `minicoder db migrate` so the schema is current before anything else starts.
#   4. Starts one `minicoder api serve` process.
#   5. Starts $WORKER_COUNT `minicoder tasks worker` processes (default 1).
#   6. Optionally starts the Next.js Web UI (`packages/web`) if START_WEB_UI=true.
#   7. Waits for the API's /healthz to respond, prints a summary, then waits on all children —
#      Ctrl-C (or `kill <pid>`) stops every child cleanly via a trap.
#
# Usage:
#   ./scripts/start-minicoder.sh                  # sqlite, 1 worker, API only
#   WORKER_COUNT=3 ./scripts/start-minicoder.sh    # sqlite, 3 workers
#   START_WEB_UI=true ./scripts/start-minicoder.sh # also start the Web UI on :3000
#   ./scripts/start-minicoder.sh --webhook-only    # run `github serve` instead of `api serve`
#                                                   # (dev-only: skips MINICODER_API_KEYS entirely)
#
# All configuration is via environment variables / a .env file in the repo root — see the
# "defaults" section below for the full list and what each one controls.

set -euo pipefail
set -m   # enable job control so each backgrounded process gets its own process group — required
         # so cleanup() below can signal a whole pnpm-exec-tsx process tree at once (see cleanup())
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # always run from the repo root, regardless of caller cwd

# ---------------------------------------------------------------------------
# 0. Parse flags
# ---------------------------------------------------------------------------
WEBHOOK_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --webhook-only) WEBHOOK_ONLY=true ;;
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
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

APP_ENV="${APP_ENV:-development}"
IS_PRODUCTION=false
[ "$APP_ENV" = "production" ] || [ "${NODE_ENV:-}" = "production" ] && IS_PRODUCTION=true

# ---------------------------------------------------------------------------
# 2. Sensible defaults for local development only. In production every one of
#    these must already be set for real (in .env, your process manager, or your
#    secrets store) — this script never invents a production secret.
# ---------------------------------------------------------------------------
REPO_ROOT="$(pwd)"   # absolute — we already cd'd to the repo root above
mkdir -p "${REPO_ROOT}/data" "${REPO_ROOT}/logs"

# --- Database (packages/triggerdev/src/db.ts) --------------------------------
# Must be an ABSOLUTE path: every `minicoder` invocation below runs via
# `pnpm --filter @minicoder/cli exec ...`, which executes with cwd=packages/cli, not the repo
# root — a relative DB_PATH would silently resolve (and create the DB file) under
# packages/cli/ instead of here.
export DB_DIALECT="${DB_DIALECT:-sqlite}"          # sqlite | postgres
export DB_PATH="${DB_PATH:-${REPO_ROOT}/data/minicoder.db}"   # sqlite only
# export DB_URL="postgres://user:pass@host:5432/minicoder"  # postgres only — set in .env

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

# --- GitHub webhook receiver (packages/github, packages/api/src/server.ts) ---
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
# export CODE_GEN_BASE_URL=...           # OpenAI-compatible LLM endpoint for Coder/Reviewer/etc.
# export CODE_GEN_API_KEY=...
# export CODE_GEN_MODEL=...

# --- Web UI (packages/web) — server-side only, never sent to the browser ------
export MINICODER_API_URL="${MINICODER_API_URL:-http://localhost:${API_PORT}}"
# export MINICODER_API_KEY=...           # must match one entry in MINICODER_API_KEYS above

START_WEB_UI="${START_WEB_UI:-false}"

# ---------------------------------------------------------------------------
# 3. Preflight
# ---------------------------------------------------------------------------
command -v pnpm >/dev/null 2>&1 || { echo "ERROR: pnpm not found on PATH (run: corepack enable)" >&2; exit 1; }

echo "==> Applying pending migrations (minicoder db migrate)"
pnpm --filter @minicoder/cli exec tsx src/index.ts db migrate

# ---------------------------------------------------------------------------
# 4. Start processes, tracking PIDs so the trap below can stop them all.
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
# 5. Wait for the API to come up, then print a summary.
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

MiniCoder is running (APP_ENV=${APP_ENV}, DB_DIALECT=${DB_DIALECT}).
  Orchestrator API : http://localhost:${API_PORT}  (also serves /webhooks/*)
  Task workers     : ${WORKER_COUNT} process(es)
  Web UI           : $( [ "$START_WEB_UI" = "true" ] && echo "http://localhost:${WEB_UI_PORT}" || echo "not started (START_WEB_UI=true to enable)" )
  Logs             : ${LOG_DIR}/*.log

Press Ctrl-C to stop everything.
SUMMARY

wait
