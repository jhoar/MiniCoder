#!/usr/bin/env bash
#
# scripts/dev-up.sh — start every MiniCoder long-running process for local development.
#
# MiniCoder's runtime is three cooperating long-running processes plus one optional UI:
#
#   1. Orchestrator API   (`minicoder api serve`)   — read/command routes AND the GitHub webhook
#                                                       receiver (it mounts the same handler
#                                                       `minicoder github serve` uses standalone —
#                                                       see CLAUDE.md's Orchestrator API section —
#                                                       so this script does not also start a
#                                                       separate `minicoder github serve` process).
#   2. Task-queue worker  (`minicoder tasks worker`) — polls `task_queue` and executes claimed
#                                                       tasks (the Trigger.dev replacement).
#   3. Web UI              (`next dev`, optional)     — @minicoder/web, talks to the Orchestrator
#                                                       API over HTTP only.
#
# Database migrations are applied once, up front, before any process starts.
#
# Usage:
#   ./scripts/dev-up.sh                    # start API + worker + web with sensible defaults
#   START_WEB=false ./scripts/dev-up.sh    # skip the Next.js dev server
#   START_WORKER=false ./scripts/dev-up.sh # skip the task worker
#   API_PORT=4100 WEB_PORT=3100 ./scripts/dev-up.sh
#
# All tunables are environment variables (see the "Configuration" section below); every one has
# a sensible local-dev default, so `./scripts/dev-up.sh` with no setup works out of the box.
#
# Stop everything with Ctrl-C — a trap sends SIGTERM to every child process and waits for clean
# shutdown (the API/worker/web processes all already implement graceful SIGINT/SIGTERM handling).

set -euo pipefail

# --- Resolve paths -----------------------------------------------------------------------------
# Always run relative to the repo root, regardless of the caller's cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# Load a local .env file if present (values already set in the calling environment still win —
# `set -a` only fills in what .env defines, and an explicit `FOO=bar ./scripts/dev-up.sh` was
# already exported by the shell before this script ran).
if [[ -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/.env"
  set +a
fi

# --- Configuration (env var, with sensible local-dev default) ----------------------------------

# Persistence: SQLite is the local/single-node profile (CLAUDE.md decision #1). Set
# DB_DIALECT=postgres and DB_URL=... to point at a hosted/team PostgreSQL instance instead.
: "${DB_DIALECT:=sqlite}"
: "${DB_PATH:=./minicoder.db}"

# Orchestrator API (mounts the read/command routes AND the GitHub webhook receiver).
: "${API_HOST:=0.0.0.0}"
: "${API_PORT:=4000}"

# Web UI (Next.js dev server). Set START_WEB=false to skip it (e.g. API/worker-only backend dev).
: "${START_WEB:=true}"
: "${WEB_PORT:=3000}"

# Task-queue worker. Set START_WORKER=false to skip it (e.g. debugging the API in isolation).
: "${START_WORKER:=true}"

# Apply pending migrations before starting any process. Set to false only if you already migrated
# and want a faster restart.
: "${RUN_MIGRATIONS:=true}"

# Where child-process logs are written (one file per process; also streamed to this terminal).
: "${LOG_DIR:=${REPO_ROOT}/logs}"
mkdir -p "${LOG_DIR}"

export DB_DIALECT DB_PATH

# --- Secrets required by the Orchestrator API ---------------------------------------------------
# `minicoder api serve` refuses to start without both of these (packages/api/src/server.ts,
# packages/api/src/auth/api-key-provider.ts). For local dev we auto-generate them if unset so the
# script works out of the box — but these are DEV-ONLY throwaway values. Never rely on
# auto-generated secrets for a hosted/team deployment; set real ones via .env or your environment.

random_hex() {
  # Prefer openssl (near-universal); fall back to /dev/urandom if it's unavailable.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

GENERATED_SECRETS=false

if [[ -z "${GITHUB_WEBHOOK_SECRET:-}" ]]; then
  export GITHUB_WEBHOOK_SECRET="dev-$(random_hex)"
  GENERATED_SECRETS=true
fi

if [[ -z "${MINICODER_API_KEYS:-}" ]]; then
  DEV_API_KEY="dev-admin-$(random_hex)"
  export MINICODER_API_KEYS="[{\"key\":\"${DEV_API_KEY}\",\"id\":\"dev-admin\",\"role\":\"admin\",\"actorKind\":\"human\",\"displayName\":\"Local dev (auto-generated)\"}]"
  export MINICODER_API_KEY="${DEV_API_KEY}"
  GENERATED_SECRETS=true
fi

# The Web UI is a server-side-only client of the Orchestrator API (CLAUDE.md's Next.js Web UI
# Operational Constraints — no client-exposed API key). Point it at the API we're about to start,
# using whichever key is configured (the auto-generated one above, or one the caller supplied).
: "${MINICODER_API_URL:=http://localhost:${API_PORT}}"
export MINICODER_API_URL
if [[ "${START_WEB}" == "true" && -z "${MINICODER_API_KEY:-}" ]]; then
  echo "Error: MINICODER_API_KEYS was supplied externally but MINICODER_API_KEY is unset." >&2
  echo "Set MINICODER_API_KEY to one of the keys in MINICODER_API_KEYS to run the web UI," >&2
  echo "or set START_WEB=false to skip it." >&2
  exit 1
fi
export MINICODER_API_KEY

if [[ "${GENERATED_SECRETS}" == "true" ]]; then
  cat <<EOF

--------------------------------------------------------------------------------
 Auto-generated dev-only secrets (not persisted; a new run generates new ones).
 Copy these into a .env file at the repo root to keep them stable across runs.
--------------------------------------------------------------------------------
 GITHUB_WEBHOOK_SECRET=${GITHUB_WEBHOOK_SECRET}
 MINICODER_API_KEYS=${MINICODER_API_KEYS}
 MINICODER_API_KEY=${MINICODER_API_KEY}
--------------------------------------------------------------------------------

EOF
fi

# --- Sanity checks -------------------------------------------------------------------------------
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm not found on PATH. Run 'corepack enable' or install pnpm first." >&2
  exit 1
fi

if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
  echo "Error: node_modules missing. Run 'pnpm install' first." >&2
  exit 1
fi

# Invoke binaries directly (root-hoisted tsx, each package's own next) rather than through
# `pnpm --filter ... run <script>` / `pnpm exec`. Both wrap the real process inside an extra
# pnpm/npm layer that does not reliably forward SIGTERM to its child — since this script's
# shutdown depends on signaling the exact backgrounded PID, every long-running process here is
# launched as that direct binary so `$!` and `kill -TERM` both refer to the real process.
TSX_BIN="${REPO_ROOT}/node_modules/.bin/tsx"
NEXT_BIN="${REPO_ROOT}/packages/web/node_modules/.bin/next"
if [[ ! -x "${TSX_BIN}" ]]; then
  echo "Error: ${TSX_BIN} not found. Run 'pnpm install' first." >&2
  exit 1
fi

# `minicoder db migrate` (packages/cli/src/commands/db.ts) shells out to a bare `tsx` command via
# spawnSync, expecting `tsx` to already be resolvable on PATH (true when run through `pnpm`,
# which is how this repo's own root `db:migrate` script and every other caller invoke it). Since
# we call the CLI directly by absolute path below rather than through pnpm, prepend the same
# node_modules/.bin directory pnpm would have added so that nested lookup still resolves.
export PATH="${REPO_ROOT}/node_modules/.bin:${PATH}"

MINICODER_CLI=("${TSX_BIN}" "${REPO_ROOT}/packages/cli/src/index.ts")

# --- Migrations ------------------------------------------------------------------------------
if [[ "${RUN_MIGRATIONS}" == "true" ]]; then
  echo "==> Applying database migrations (DB_DIALECT=${DB_DIALECT})..."
  "${MINICODER_CLI[@]}" db migrate
fi

# --- Process supervision -----------------------------------------------------------------------
# Track child PIDs so the trap below can shut everything down together on Ctrl-C.
PIDS=()

# Starts one long-running process in the background, tees its combined output to both a log file
# and this terminal (prefixed with the process name), and records its PID. Uses process
# substitution (`> >(...)`) rather than a shell pipeline (`cmd | tee ...`) specifically so `$!`
# captures the real command's PID, not the trailing pipeline stage's — that PID is what
# `shutdown()` below signals directly.
start_process() {
  local name="$1"
  shift
  local logfile="${LOG_DIR}/${name}.log"
  echo "==> Starting ${name} (log: ${logfile})"
  "$@" > >(sed -u "s/^/[${name}] /" | tee -a "${logfile}") 2>&1 &
  PIDS+=("$!")
}

# Guards against running twice: bash re-triggers the EXIT trap after an INT/TERM trap handler
# returns and the script falls through to the end, so without this a Ctrl-C would run the whole
# shutdown sequence twice.
SHUTTING_DOWN=false
shutdown() {
  if [[ "${SHUTTING_DOWN}" == "true" ]]; then
    return
  fi
  SHUTTING_DOWN=true
  echo ""
  echo "==> Shutting down (${#PIDS[@]} process(es))..."
  for pid in "${PIDS[@]}"; do
    kill -TERM "${pid}" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "==> All processes stopped."
}
trap shutdown EXIT INT TERM

start_process "api" "${MINICODER_CLI[@]}" api serve --port "${API_PORT}" --host "${API_HOST}"

if [[ "${START_WORKER}" == "true" ]]; then
  start_process "worker" "${MINICODER_CLI[@]}" tasks worker
fi

if [[ "${START_WEB}" == "true" ]]; then
  if [[ ! -x "${NEXT_BIN}" ]]; then
    echo "Error: ${NEXT_BIN} not found. Run 'pnpm install' first, or set START_WEB=false." >&2
    exit 1
  fi
  # `next dev`'s optional positional [directory] argument points it at packages/web regardless
  # of this script's own cwd (REPO_ROOT) — no `cd` needed.
  start_process "web" "${NEXT_BIN}" dev "${REPO_ROOT}/packages/web" --port "${WEB_PORT}" --hostname "0.0.0.0"
fi

cat <<EOF

--------------------------------------------------------------------------------
 MiniCoder is starting up:
   Orchestrator API : http://localhost:${API_PORT}
$( [[ "${START_WEB}" == "true" ]] && echo "   Web UI           : http://localhost:${WEB_PORT}" )
   Logs             : ${LOG_DIR}/
 Press Ctrl-C to stop everything.
--------------------------------------------------------------------------------

EOF

# Wait on every backgrounded process; the trap above handles Ctrl-C / SIGTERM.
wait
