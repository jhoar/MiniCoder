# MiniCoder — Claude Code Project Guide

## What This Repository Is

MiniCoder is an **Agentic Software Development Orchestration System** that converts user intent or
system specifications into a clarified, approved, sequential implementation backlog, then
orchestrates feature-branch development, pull requests, structured reviews, fixes, merge gates,
and final design documentation.

This repository contains the **Phase 1–3 and Phase 5 implementation**: monorepo skeleton, persistence
abstraction (SQLite + PostgreSQL), 43-table initial schema, migration tooling, config/secrets
backends, database lifecycle CLI (`minicoder db`), CI (Phase 1); full state-machine / command
layer with state-transition validator, transactional idempotent commands, outbox/inbox dispatching,
workflow locks with fencing tokens, execution lanes, local auth, secret-redaction tests, and the
`minicoder state` CLI (Phase 2); the Workflow Layer harness with a 9-service Trigger.dev v4
Docker Compose stack (`infra/docker-compose.triggerdev.yml`), 9 task stubs registered via
`@trigger.dev/sdk/v3`, `assertSchemaReady()` post-connect schema probe, CI/CD deploy workflow
(`.github/workflows/trigger-deploy.yml`), and `minicoder trigger` CLI scaffold (Phase 3); and the
Agent Adapter Foundation — the six role interfaces, `AdapterRegistry`, the capability model with
runtime validation, `AgentRunRecorder` with automatic provenance snapshotting, six deterministic
mock adapters (including `HumanTestAdapter`), and the Phase 5 smoke conformance suite (Phase 5,
migrations 0003–0006).
Canonical specification documents live under `docs/`.

## Repository Structure

```
README.md                                # Non-authoritative summary + doc map
CLAUDE.md                                # This file
docs/
  00-glossary-and-terms.md              # CANONICAL: states, roles, adapters, CLI, tech stack
  01-system-specification.md            # CANONICAL: architecture, data design, API, merge policy
  02-bootstrap-planner-clarification.md # CANONICAL: planning, readiness, clarification workflow
  03-agent-adapter-architecture.md      # CANONICAL: adapter roles, conformance, execution contract
  04-testing-validation-state-lifecycle.md # CANONICAL: testing, lifecycle tooling, runbooks
  05-ui-specification.md                # CANONICAL: TUI + Web UI specs
  06-implementation-plan.md             # CANONICAL: 18-phase implementation plan
  07-security-and-secrets.md            # CANONICAL: secrets, auth, sandboxing, payload hygiene
```

**Precedence rule:** Everything under `docs/` is canonical. If `README.md` prose and a `docs/` file
disagree, the `docs/` file wins. Within `docs/`, shared vocabulary is defined once in
`00-glossary-and-terms.md`; other files reference it.

## Development Branch

Each session works on a dedicated PR branch specified in the session system prompt. Always
push with:

```bash
git push -u origin <branch-from-session-prompt>
```

Never push directly to `main`.

## Key Architectural Decisions (Do Not Change Without Explicit Instruction)

These are locked decisions that appear throughout the docs. Do not contradict or soften them:

1. **One architecture, two state-store profiles.** SQLite = local/single-node; PostgreSQL =
   hosted/team. Both are in scope from Phase 1. PostgreSQL is never "deferred."

2. **Sequential execution is a policy setting, not a schema limitation.** Enforced via workflow
   locks/leases with fencing tokens (monotonically increasing; persistence layer rejects
   stale-fence writes), not a hard schema invariant.

3. **GitHub webhooks are the primary event source.** Scheduled reconciliation is the fallback/
   repair mechanism, not the primary path.

4. **Workflow Layer** is the subsystem name for durable workflow execution. The implementation is
   Trigger.dev, but the docs use "Workflow Layer" for the architectural role everywhere except when
   explicitly referring to the Trigger.dev product (CLI namespace `minicoder trigger ...`, deployment
   tiers/backends, concrete runtime diagnostics like "underlying Trigger.dev run").

5. **Trigger.dev execution backend is a separate axis from the state store.** Default = self-host
   single-node (Docker Compose: webapp + Postgres + Redis + worker). Self-host HA cluster and
   Trigger.dev Cloud are drop-in options. Switching backends is a deployment/config decision only —
   except Cloud is also a security/compliance decision (payloads leave the user's boundary).

6. **Security is a design property established in Phases 1–3.** Never defer secrets management,
   audit actor identity, webhook-secret verification, or workspace sandboxing to later phases.

7. **Orchestrator Core is provider-SDK-free.** No provider SDK import in core. Domain logic stays
   in core, not in Workflow Layer task wrappers (architectural fitness tests enforce this in Phase 2).

8. **Markdown artifacts are never runtime state.** `plan.md`, `backlog.md`,
   `final-design-document.md` are generated/importable snapshots only.

9. **Private chain-of-thought is never stored or exposed.**

10. **SQLite is never used over a network filesystem.** Hosted/team always uses PostgreSQL.

## Vocabulary — Always Use These Exact Tokens

State names, role names, and identifier formats are canonical in `docs/00-glossary-and-terms.md`.
Use them verbatim:

### Feature execution states (§3.2)

```
approved_pending_execution → selected → coding → code_pushed → pr_opened → ci_running
→ under_review → changes_requested → fixing → code_pushed → ci_running → under_review
→ approved_by_policy → merge_ready → merged
```

Also: `ci_failed`, `merge_failed`, `human_required`, `blocked`, `failed`, `system_failed`

### Automation control states (§3.8)

```
running | paused_by_operator | paused_budget_exceeded | waiting_for_budget_approval
```

`resumed` is an **event**, not a state.

### Planning states (§3.1)

```
draft → pending_approval → approved → activated_for_execution
```

### Project lifecycle (§3.1)

```
active → implementation_complete → design_document_generating
→ design_document_ready_for_review → design_document_approved → project_complete
```

Revision loop: `design_document_ready_for_review → design_document_revision_requested
→ design_document_generating → design_document_ready_for_review`

### Agent adapter role names (§4.1)

```
PlannerAgentAdapter | CoderAgentAdapter | ReviewerAgentAdapter
ArbiterAgentAdapter | DocumentationAgentAdapter | HumanAgentAdapter
```

### Test mock names (§4.2)

```
MockPlannerAdapter | MockCoderAdapter | MockReviewerAdapter
MockArbiterAdapter | MockDocumentationAdapter | HumanTestAdapter
```

`HumanTestAdapter` is the deterministic test mock of `HumanAgentAdapter` — not the same thing.

### User/auth roles (§4.4)

```
viewer | operator | approver | admin
```

`approver`/`admin` is required for: plan activation, budget override, disagreement resolution,
merge-if-ready, final design-document approval, and guarded/destructive lifecycle actions.

### Identifiers (§3.11)

- Feature-request IDs: `FR-<zero-padded-int>` (e.g., `FR-002`)
- Feature branches: `minicoder/FR-<n>` (e.g., `minicoder/FR-002`)
- GitHub review-gate status check: `minicoder/review-gate`

### Workflow Layer task IDs (exact strings, no drift)

```
planning-readiness-assessment | start-clarification | generate-implementation-plan
generate-feature-backlog | activate-approved-backlog | start-next-feature
github-reconciliation | export-plan | export-backlog
```

### Review finding severities (§3.7)

```
blocking | non_blocking | question | nit | out_of_scope | requires_human_decision
```

`requires_human_decision` prevents merge and routes via `human_required`.

## CI Loop Rule

**Every new push re-enters CI.** A fix always flows:

```
fixing → code_pushed → ci_running
```

before returning to `under_review`. Review and merge never act on un-tested code.

## Outbox / Inbox Rules

- Draining is **deterministic backoff polling**, NOT WAL-tailing (portability across SQLite/PostgreSQL).
- Each `outbox_events`/`inbox_events` row stores `payload` + `payload_schema_version` (the Zod schema version string).
- Task payloads carry **references and IDs, never secrets** and never raw secret-bearing material.
- `InboxProcessor` validates `payload_schema_version === SCHEMA_VERSION` and runs `validateEventPayload()` before calling any handler; mismatches are marked `failed` without invoking the handler.
- Batch SELECT uses a two-pass strategy: known event types fill the batch first (`IN (...)`), then unknown types fill the remainder (`NOT IN (...)`). Unknown events are never allowed to starve registered handlers.
- Events with no registered handler are requeued with `next_retry_at = now + maxBackoffMs` (attempts not incremented) so they become eligible once a handler is registered.

## Workflow Package Operational Constraints (`packages/workflow/`)

- **`staleClaimMs` must be a finite integer ≥ 2.** Both `OutboxDispatcher` and `InboxProcessor` throw in the constructor for values below 2, `NaN`, `Infinity`, or non-integers. Values below 2 produce a zero-delay heartbeat spin loop AND make the stale-claim threshold fire immediately (reclaiming active claims on the very next poll).
- **Heartbeat ownership loss.** The heartbeat UPDATE uses `executeAffected`; if 0 rows are returned (stale-claim recovery reclaimed the row) or the UPDATE throws (transient DB failure), `lostOwnership` is set and the handler result is **not** counted — `markDelivered`/`markProcessed`/`markFailed` is skipped. The handler still runs to completion.
- **Lock fencing — release is an UPDATE, not a DELETE.** `WorkflowLockManager.release()` updates `expires_at = now` and increments `fence`, preserving the row. The monotonically increasing fence counter must survive across acquire/release cycles so re-acquisition always returns a strictly higher fence. Deleting the row would reset the fence to 1.
- **`assertFence` must run inside the same transaction as the guarded write** to prevent TOCTOU races between the fence check and the protected state mutation.

## Trigger.dev Operational Constraints (`packages/triggerdev/`)

- **9-service compose stack.** `infra/docker-compose.triggerdev.yml`: `triggerdev-init`
  (one-shot alpine:3.19 chown, must exit 0 before webapp/supervisor start), postgres, redis,
  electric, webapp, registry, minio, docker-proxy, supervisor.
- **Supervisor network.** Supervisor must join the `triggerdev-webapp` Docker network.
  Set `TRIGGER_WORKLOAD_API_DOMAIN=triggerdev-supervisor` so runner containers can reach the
  workload API by hostname. Supervisor healthcheck uses a Node `http.get` call (no curl in
  the Node image).
- **OTEL endpoint.** `OTEL_EXPORTER_OTLP_ENDPOINT=http://triggerdev-webapp:3000/otel` —
  NOT the standard OpenTelemetry port `:4318`.
- **Registry topology.** `DEPLOY_REGISTRY_HOST` (CLI push target) and `DOCKER_REGISTRY_URL`
  (supervisor pull source) must point to the same registry. For GitHub-hosted CI runners,
  `localhost:5000` is unreachable; both vars need an external registry.
- **`assertSchemaReady()`.** `packages/triggerdev/src/db.ts` probes `triggerdev_runs`
  immediately after connecting. Missing table → actionable error. Run `minicoder db migrate`
  before starting tasks.
- **CLI pin.** Deploy with `npx trigger.dev@4.4.6 deploy …`. Never use `@latest`.
- **All secrets use `${VAR:?message}` syntax** in `docker-compose.triggerdev.yml` — Docker
  Compose exits on missing/empty values.

## Agent Adapter Operational Constraints (`packages/core/src/adapters/`, `packages/testing/src/conformance/`)

- **`AdapterRegistry.register` uses `INSERT ... ON CONFLICT (role, name) DO NOTHING`, never a
  catch-and-requery pattern.** In PostgreSQL, a failed `INSERT` (unique-constraint violation)
  aborts the enclosing transaction, so any later query in that same transaction fails with
  "current transaction is aborted". `DO NOTHING` never errors, so re-selecting the winning row
  and falling through to `UPDATE` stays inside a healthy transaction. Idempotent re-registration
  replaces capabilities and increments `version`.
- **Capability tokens are always runtime-validated via `parseCapabilities()`, never cast
  directly.** Both `AdapterRegistry.register()` (caller-supplied input) and `toRecord()` (rows
  read back from `agent_capabilities`) call it; an unrecognized token throws
  `InvalidCapabilityError` rather than silently defeating `assertCapabilities`. It also dedupes
  and **sorts the result by canonical `AgentCapabilitySchema` order** — not by insertion order,
  `created_at`, or physical row order — because multiple capability rows written in the same
  registration call share an identical `created_at` timestamp, so timestamp-based ordering alone
  would not be reliably deterministic across storage engines.
- **`agent_configurations` has two partial unique indexes (migration 0006), not a single
  `UNIQUE(adapter_id, project_id)`.** A plain composite unique constraint would not catch
  duplicate default rows, since SQL treats every `NULL` as distinct: `uq_agent_configurations_default`
  on `(adapter_id) WHERE project_id IS NULL` (at most one default config per adapter) and
  `uq_agent_configurations_project` on `(adapter_id, project_id) WHERE project_id IS NOT NULL`
  (at most one config per adapter/project pair). `AdapterRegistry.getConfiguration()` still adds
  a `version DESC, updated_at DESC` tiebreaker as defense-in-depth.
- **SQLite migration preflight remediation comments use `ROW_NUMBER() OVER (PARTITION BY ...
ORDER BY updated_at DESC, id DESC)`, never `MAX(rowid)`.** `rowid` reflects insertion order,
  not `updated_at`, and does not match the stated "keep the most-recently-updated row" policy.
  This applies to the dedup guidance in migrations `0003_unique_adapter_role_name.sqlite.sql` and
  `0006_unique_agent_configurations.sqlite.sql`.
- **`AgentRunRecorder.record()` resolves adapter provenance from the registry automatically —
  callers never supply `adapterName`/`adapterImplementation`/`adapterVersion`.** It also validates
  the caller-supplied `role` against the registry record (`RunRoleMismatchError` on mismatch) and
  validates `capabilitiesUsed` is a subset of the adapter's declared capabilities
  (`UndeclaredCapabilityError` otherwise). `capabilitiesUsed` is a **required** field on
  `RecordRunOptions` (never defaulted to `[]`) so a capability-bearing run cannot silently
  persist an empty provenance record — pass `[]` explicitly only for calls that genuinely
  exercise no declared capability.
- **`adapter_conformance_results` is append-only.** There is no unique key on
  `(test_suite, adapter_id)` and `runConformanceSuite()` never upserts — every call inserts a
  fresh row per adapter, even when re-run against the same DB with the same (idempotently
  re-registered) adapters. It is a historical audit log, not a current-gate-state row; query
  `ORDER BY run_at DESC LIMIT 1` scoped to `(test_suite, adapter_id)` for "the current result".
  The conformance runner's `configuration_resolution` scenario upserts (SELECT-then-UPDATE-or-
  INSERT) its own default config row rather than using an unconditional `INSERT`, so
  `runConformanceSuite()` is safe to re-run against a persistent DB.
- **Phase 5 delivers smoke-level conformance only.** The 9-scenario suite verifies adapter
  wiring (capability declaration, successful run, failure handling, invalid-output handling,
  secret redaction, configuration resolution, state-transition sequence, output shape,
  assertCapabilities) via direct invocation by the conformance runner and `AgentRunRecorder` —
  not via Workflow Layer task wrappers. Timeout taxonomy, cost/token reporting, structured-output
  normalization, and Workflow Layer wrapper invocation are deferred to the full canonical
  adapter-contract gate in Phase 9+.

## Cross-Dialect Testing (Mandatory)

The integration test suite and migration validation **must** run against both SQLite and PostgreSQL
as a matrix. This is a CI requirement, not optional. The security scan
(pnpm audit/OSV + gitleaks + semgrep) also runs in CI.

CI enforces `pnpm audit --prod --audit-level=high` (runtime dependencies only). Two dev-only
advisories are known and accepted: GHSA-5xrq-8626-4rwp (vitest critical — UI server not used) and
GHSA-fx2h-pf6j-xcff (vite high — Windows-only path, CI runs Linux). Full rationale in
docs/04 §12.13. Full `pnpm audit --audit-level=high` will report these locally — that is expected.

## Vitest Test Command Tiers

| CLI command                  | What it runs                                                                     | Config                                      |
| ---------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- |
| `minicoder test unit`        | All `*.test.ts` except `*.integration.test.ts` (includes scenario/fixture tests) | `vitest.unit.config.ts`                     |
| `minicoder test integration` | Only `*.integration.test.ts` (requires real DB)                                  | root `vitest.config.ts` + positional filter |
| `minicoder test system`      | Programmatic scenario runner (`runAllScenarios()`)                               | —                                           |
| `pnpm test`                  | All `*.test.ts` including integration                                            | root `vitest.config.ts`                     |

`vitest.unit.config.ts` excludes `**/*.integration.test.ts` and is the only way to run the
non-integration Vitest tier via CLI. Do not add `--include`/`--exclude` CLI flags — Vitest 1.6.x
does not support them; use a separate config file instead.

## SQLite Test Teardown Rule

**Never call `db.close()` in tests** (including `afterEach`/`afterAll` hooks).

`better-sqlite3` registers native GC finalizers for `Database` and `Statement` objects.
Explicit `db.close()` calls `sqlite3_close()`, which finalizes all statements on the database.
When V8's GC later runs the `Statement` finalizer, it double-frees → SIGSEGV (exit 139). Let
GC handle teardown order naturally — do not add explicit close calls.

`vitest.config.ts` uses `pool: 'forks'`: each test file runs in a forked child process that
calls `process.exit()` on completion, bypassing V8 GC finalizers entirely. Do not change
`pool` without understanding this constraint.

## Typecheck Script Ordering

The root `pnpm typecheck` script builds packages sequentially (generating `dist/`) before
running `--noEmit` on dependents. Any package whose `types` field points to `dist/` must
appear in the ordered build chain in `package.json` before the recursive `pnpm -r` pass.
Current order: `core → persistence-sqlite → persistence-postgres → triggerdev → testing → (rest --noEmit)`.

When adding a new workspace package that others import for types, add it to this chain.

## Budget Gate

The budget-gate primitive ships in **Phase 8** (not Phase 16). Phase 16 adds dashboards and
forecasting only.

Key tables: `budget_policies` (thresholds/config). Key transitions:

- Hard limit breach → `paused_budget_exceeded`
- Soft limit breach → `waiting_for_budget_approval`

The review/fix loop is also a budget scope; breaching the per-feature threshold trips the circuit
breaker and escalates to human.

## Security Sandbox Rules (docs/07, §6)

- Workspaces are ephemeral and isolated per agent run.
- Default-deny egress: only the assigned LLM provider and GitHub are allow-listed.
- Dependency provisioning under default-deny: pre-baked base image, read-only bind-mounted
  pre-indexed pnpm store, or internal package proxy/mirror. The public npm registry is never
  directly reachable from the sandbox in hosted/team. Local dev may use a clearly-labelled
  allow-list (forbidden in hosted/team).
- Bounded diffs: max diff size enforced; no merge commits from the sandbox.

## State Repair CLI

`state repair` requires `--project <id>` and two steps:

1. `minicoder state repair --project <id> --dry-run` — previews changes, prints a single-use
   confirmation token (expires in 5 minutes).
2. `minicoder state repair --project <id> --apply --confirmation <token>` — executes; token is
   time-boxed, single-use, and bound to the project ID that issued it.

`state purge` does not exist. Irreversible maintenance uses only the guarded `repair --apply` path.
Global (unscoped) repair is not supported — `--project` is mandatory for both steps.

## State Reconcile CLI

`state reconcile` requires either `--project <id>` or `--all`:

- `--project <id>` only: clears stale workflow locks scoped to that project; does **not** touch
  global queues.
- `--all`: clears stale locks globally **and** marks stuck `outbox_events`/`inbox_events` as
  failed. Global queue mutation requires explicit `--all`.
- Neither flag: exits 1.

`outbox_events` and `inbox_events` have no `project_id` column and are always global scope.
`state doctor` and `state export-diagnostics` label these entries with `scope: 'global'`.
`state export-diagnostics` groups all global tables under `globalOperationalState: { scope: 'global', ... }`.

## Dev/Test-Only Command Safety Guards

The following commands write directly to application tables and are restricted to development, test,
and CI environments:

- `minicoder db seed` — inserts fixture data
- `minicoder db restore` — overwrites the live database file
- `minicoder github simulate-*` — inserts inbox events

All three commands call `guardEnv()` which enforces two levels:

1. **Hard production reject (cannot be overridden):** exits 1 immediately if `APP_ENV` or
   `NODE_ENV` is `'production'` — regardless of any `--env` flag passed by the caller.
2. **Allowed-env check:** target env (from `--env`, then `APP_ENV`, then `NODE_ENV`) must be one
   of `development`, `test`, or `ci`.

`--env development` cannot be used to bypass a production process environment.

## What Multiple State Machines Look Like

There are several distinct state machines — not one:

- **Project**: `active → implementation_complete → ... → project_complete`
- **Plan**: `draft → pending_approval → approved → activated_for_execution`
- **Feature (execution)**: §3.2 above
- **PR/review**: mirrors GitHub (`none | pending | commented | changes_requested | approved | dismissed`)
- **Agent run**: `queued | running | succeeded | failed | cancelled`
- **Workflow run**: `queued | running | waiting | succeeded | failed | cancelled`
- **Clarification session**: §3.6 above
- **Artifact export**: `pending | generating | exported | stale | failed`
- **Budget gate**: §3.8 above

## Technology Stack (Locked)

| Concern              | Choice                              |
| -------------------- | ----------------------------------- |
| Language             | TypeScript                          |
| Runtime              | Node.js                             |
| Package manager      | pnpm                                |
| Local/single-node DB | SQLite                              |
| Hosted/team DB       | PostgreSQL                          |
| Validation           | Zod                                 |
| Testing              | Vitest                              |
| GitHub API           | Octokit                             |
| Workflow execution   | Trigger.dev                         |
| API framework        | Fastify                             |
| Text UI              | Ink                                 |
| Web UI               | React / Next.js                     |
| Security scanning    | pnpm audit/OSV + gitleaks + semgrep |

## Editing Guidelines for Documentation

- Every `docs/` file must keep its `Status: Canonical`, `Supersedes:`, `Version:`, and
  `Last-updated:` header.
- State names, role names, adapter names, and CLI commands used in any doc must match
  `00-glossary-and-terms.md` exactly.
- Do not introduce a new term, state, or adapter name without adding it to `00-glossary-and-terms.md`
  first.
- After editing docs, run grep sweeps to verify no stale/removed tokens remain (e.g., search for
  old status-check names, removed CLI commands, or superseded role names).
- `docs/06-implementation-plan.md` is the **single canonical 18-phase plan**. Do not add a
  parallel or competing phase list elsewhere.

## Discovery Backlog

The "discovery backlog" concept maps to `feature_requests` rows with `kind=discovery,
executable=false`. Backlog activation excludes `kind=discovery` rows. They are never directly
executable.

## Clarification Circuit Breaker

Clarification has a per-round timeout and a maximum of 3 rounds. Exceeding these limits produces
`clarification_blocked` followed by `human_required`.
