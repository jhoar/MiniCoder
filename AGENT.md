# MiniCoder Agent Guide

## Purpose

This repository implements **MiniCoder**, an agentic software-development orchestration system.
MiniCoder turns specifications into an approved, database-backed backlog and is designed to
orchestrate feature branches, pull requests, reviews, fixes, merge gates, and final design
documentation.

Use this file as the practical guide for modifying the repository. The canonical product and
architecture requirements remain under `docs/`.

## Current Repository State

- The canonical specification describes an 18-phase target architecture.
- The codebase currently contains the **Phase 1–6 implementation**:
  - TypeScript/pnpm monorepo
  - domain state and entity types
  - persistence abstractions
  - SQLite and PostgreSQL adapters
  - paired migrations and database lifecycle CLI commands
  - eight lifecycle state machines and a transition validator
  - transactional, idempotent command execution and representative command handlers
  - versioned event schemas, outbox/inbox dispatch, and idempotency sweeping
  - workflow locks with fencing tokens and sequential execution lanes
  - local authentication, authorization guards, and secret redaction
  - database-backed state lifecycle CLI commands for inspect, validate, doctor, reconcile, diagnostics, and scoped repair
  - Phase 4 testing harness with deterministic fixtures, mock adapters, scenario registry, and system-test CLI commands
  - database lifecycle seed, snapshot, restore, and diff helpers for disposable local/CI workflows
  - GitHub event simulation CLI commands for development/test inbox scenarios
  - Workflow Layer harness backed by Trigger.dev v4 task wrappers
  - 9-service self-hosted Trigger.dev Docker Compose stack
  - Trigger.dev deployment workflow and `minicoder trigger` CLI scaffold
  - provider-neutral agent adapter role interfaces and shared role-specific I/O contracts
  - canonical agent capability token parsing, validation, and deterministic ordering
  - database-backed `AdapterRegistry` for `(role, name)` registration, capability validation,
    configuration resolution, and source-of-truth lookup
  - `AgentRunRecorder` lifecycle persistence with state-machine validation, redaction,
    normalized errors, and immutable Phase 5 adapter provenance snapshots
  - six-role smoke conformance framework with `HumanTestAdapter`, append-only results, skipped
    scenario accounting, and rerun-safe configuration setup
  - `clarification_sessions`/`clarification_questions`/`clarification_answers`/`clarification_decisions`
    schema persisting the `ClarificationStatus` machine, including assessment-scoped sessions and
    nullable `clarification_session_id` links on `planning_gaps`/`planning_assumptions`
  - backlog validation tracking on `implementation_plans` (`backlog_version`,
    `backlog_validated_at`, `backlog_validated_state`, `backlog_validated_version`) so approval
    requires validation evidence for the current backlog
  - planning and clarification command handlers (`packages/core/src/commands/handlers/planning/`,
    `.../clarification/`) covering specification ingestion, planner-adapter-backed readiness
    assessment, assessment-scoped plan/backlog generation and validation, approval, activation
    (creating `feature_runs` rows), artifact export, backlog import, and the clarification circuit
    breaker
  - all 15 canonical Trigger.dev task IDs registered, with the 9 planner/clarification tasks now
    calling real Orchestrator Core commands instead of returning stub values
  - migration, configuration, security, workflow, Trigger.dev, and architectural fitness tests
- Do not describe the repository as specification-only.
- Phase 7 and later remain target architecture. Do not assume later phases are implemented merely
  because their schemas, state machines, CLI scaffolds, task stubs, or types already exist.
- Phase 3 delivered 9 initial task IDs as payload-validated stubs; Phase 6 wired the
  planner/clarification tasks (`ingest-specification`, `planning-readiness-assessment`,
  `start-clarification`, `record-clarification-answer`, `complete-clarification`,
  `generate-implementation-plan`, `generate-feature-backlog`, `validate-backlog`,
  `request-plan-approval`, `activate-approved-backlog`, `export-plan`, `export-backlog`,
  `import-backlog`) to real core commands. `start-next-feature` and `github-reconciliation` remain
  stubs pending Phase 7/8.
- Phase 5 is an adapter foundation and smoke conformance layer, not the full canonical provider
  adapter runtime. Provider-specific adapters, workflow task-wrapper invocation, richer
  provider/model/cost/token fields, and final canonical run metadata remain later-phase work unless
  the implementation plan says otherwise.
- Phase 6's `planning-readiness-assessment` and `generate-implementation-plan` tasks never import a
  concrete `PlannerAgentAdapter` implementation — the caller injects one. No reference/generic
  planner adapter has shipped yet (docs/02 §7 names `GenericLLMPlannerAdapter` as future work), so a
  live Trigger.dev deployment fails fast with an actionable error until one exists.
- Before starting work, inspect the current branch, recent commits, and working tree:

```bash
git status --short --branch
git log --oneline -10
```

Never hard-code a development branch name in instructions or scripts.

## Sources of Truth

Apply this precedence when requirements appear to conflict:

1. The current user/task requirements.
2. Canonical documents under `docs/`.
3. Tests and executable code for current implementation behavior.
4. `README.md` and `CLAUDE.md` as non-authoritative summaries.

Within `docs/`:

- `docs/00-glossary-and-terms.md` owns shared vocabulary, exact state tokens, roles, adapter names,
  identifiers, CLI names, deployment profiles, and the locked stack.
- `docs/01-system-specification.md` owns architecture, authority boundaries, consistency, API
  conventions, merge policy, and project acceptance validation.
- `docs/06-implementation-plan.md` is the only canonical phase plan.
- `docs/07-security-and-secrets.md` is authoritative for secrets, authentication, sandboxing,
  egress, payload hygiene, and untrusted content.

Read the documents in numeric order when a change crosses subsystem boundaries.

## Repository Map

```text
docs/                           Canonical product and architecture specifications
packages/core/                  Provider-neutral domain, config, persistence, and adapter contracts
packages/persistence-sqlite/    better-sqlite3 implementation of core persistence contracts
packages/persistence-postgres/  pg implementation of core persistence contracts
packages/migrations/            Paired SQLite/PostgreSQL migrations and lifecycle runner
packages/workflow/              Locks, execution lanes, outbox/inbox dispatch, and sweepers
packages/triggerdev/            Trigger.dev Workflow Layer harness and task registrations
packages/testing/               Deterministic fixtures, mock adapters, conformance, scenarios, and runner
packages/cli/                   Thin Commander-based CLI
infra/docker-compose.triggerdev.yml  Self-hosted Trigger.dev v4 single-node stack
infra/docker-compose.test.yml   Disposable PostgreSQL test stack
infra/k8s/                      Batch jobs for migrations, seed, diagnostics, reconciliation, and system tests
.github/workflows/ci.yml        CI checks, database matrix, system smoke, and production dependency audit
.github/workflows/trigger-deploy.yml Trigger.dev task deployment workflow
```

Important files:

- `packages/core/src/domain/states.ts` mirrors canonical tokens from the glossary.
- `packages/core/src/domain/entities.ts` defines persisted domain shapes.
- `packages/core/src/persistence/types.ts` defines database-neutral interfaces and concurrency
  errors.
- `packages/core/src/statemachine/machines/` contains the eight implemented transition matrices.
- `packages/core/src/commands/` contains the command registry, executor, and contracts.
- `packages/core/src/commands/handlers/planning/` and `.../clarification/` contain the Phase 6
  planning and clarification command handlers. `ValidateBacklogHandler` owns backlog quality
  evidence, and `SubmitPlanForApprovalHandler` must require current valid backlog evidence before
  `pending_approval`.
- `packages/core/src/events/schemas.ts` owns versioned event payload validation.
- `packages/core/src/auth/` contains actor identity, local auth, authorization, and redaction.
- `packages/core/src/adapters/types.ts` defines provider-neutral role adapter interfaces and I/O
  contracts.
- `packages/core/src/adapters/capabilities.ts` owns capability token schemas, validation, and
  canonical ordering.
- `packages/core/src/adapters/registry.ts` implements database-backed adapter registration,
  capability validation, configuration resolution, and source-of-truth lookup.
- `packages/core/src/adapters/run-recorder.ts` persists adapter run lifecycles, redacted summaries,
  normalized errors, and Phase 5 adapter provenance snapshots.
- `packages/workflow/src/locks/manager.ts` implements lease ownership and fencing.
- `packages/workflow/src/outbox/dispatcher.ts` and `inbox/processor.ts` implement durable dispatch.
- `packages/triggerdev/src/task-ids.ts` owns all 15 canonical task ID constants (`ALL_TASK_IDS`).
- `packages/triggerdev/src/triggerdev-tasks.ts` registers the Trigger.dev task wrappers.
- `packages/triggerdev/src/db.ts` links Trigger.dev runs to `triggerdev_runs` and probes schema
  readiness.
- `packages/triggerdev/trigger.config.ts` configures Trigger.dev deployment.
- `packages/migrations/src/index.ts` exports the expected table list.
- `packages/migrations/src/runner.ts` implements migration lifecycle commands.
- `packages/migrations/migrations/*.sqlite.sql` and `*.postgres.sql` must evolve together. Current
  Phase 6 planning schema is split across `0007_clarification_sessions.*` and
  `0008_backlog_validation_tracking.*`.
- `packages/testing/src/fixtures/` owns SQLite-only deterministic fixture setup for local/system scenarios.
- `packages/testing/src/adapters/` owns mock role adapters and the test-only `HumanTestAdapter`.
- `packages/testing/src/conformance/` owns the Phase 5 smoke conformance runner and append-only
  result persistence.
- `packages/testing/src/scenarios/` owns the registered scenario flows exercised by `minicoder test system`.
- `infra/docker-compose.triggerdev.yml` owns the local self-hosted Trigger.dev stack.
- `infra/docker-compose.test.yml` owns the disposable PostgreSQL service used by cross-dialect validation.

## Locked Architectural Invariants

Do not contradict these rules without an explicit architecture change to the canonical docs:

1. The MiniCoder database is authoritative for planning, workflow, review, event, cost, artifact,
   and design-document state.
2. GitHub is authoritative for repository, branch, commit, pull request, review, CI, mergeability,
   and merge state.
3. GitHub webhooks are primary; scheduled reconciliation is fallback and repair.
4. SQLite is the local/single-node state store. PostgreSQL is the hosted/team state store and is
   not deferred.
5. SQLite must never be used over a network filesystem.
6. Sequential feature execution is enforced by policy, locks/leases, lanes, and fencing tokens—not
   by a schema limitation.
7. Workflow Layer tasks are thin, idempotent wrappers around Orchestrator Core commands. Business
   rules belong in core.
8. `packages/core` remains free of provider SDKs and concrete database drivers.
9. Markdown artifacts are generated/importable snapshots, never runtime state.
10. Private chain-of-thought is never requested, persisted, logged, or exposed.
11. Every push, including a review fix, must re-enter CI before review or merge.
12. Task and event payloads carry IDs/references, schema versions, and secret-free data.

## Package Boundaries

### `@minicoder/core`

- Keep domain logic independent of SQLite, PostgreSQL, Trigger.dev, GitHub SDKs, and LLM providers.
- Import only abstractions into core.
- Access environment configuration only through `src/config/`.
- Keep adapter contracts provider-neutral and free of provider SDK imports.
- Validate adapter capabilities through `AgentCapabilitySchema`; do not accept ad hoc capability
  strings.
- Treat the adapter registry as the source of truth for active adapter configuration and capability
  matching.
- Add canonical state literals to `docs/00-glossary-and-terms.md` before adding them to
  `states.ts`.
- Export public contracts through `src/index.ts`.

The ESLint rules and `fitness/no-provider-imports.test.ts` enforce part of this boundary. Extend
fitness tests when introducing a new architectural restriction.

### `@minicoder/workflow`

- Keep workflow primitives database-backed, deterministic, and portable across SQLite and
  PostgreSQL.
- Call Orchestrator Core commands for business transitions; do not move domain policy into workflow
  wrappers.
- Preserve at-least-once dispatch semantics and idempotent handlers.
- Validate `payload_schema_version` and event payloads before invoking inbox handlers.
- Preserve deterministic backoff and the two-pass known/unknown event selection that prevents
  unknown event types from starving registered handlers.
- Treat heartbeat ownership loss as authoritative: do not mark a handler result after its claim is
  lost.
- Validate `staleClaimMs` as a finite integer greater than or equal to 2.
- Release locks by expiring and incrementing the stored fence; never delete the lock row and reset
  its fencing history.
- Run `assertFence` in the same transaction as the write it guards.

### Persistence packages

- Implement `PersistenceBackend`, `DbClient`, and `TxClient` from core.
- Keep dialect-specific SQL and driver behavior outside core.
- Preserve transaction rollback on failure.
- Preserve SQLite foreign-key enforcement and local WAL behavior.
- Account for genuine SQLite/PostgreSQL differences rather than pretending their concurrency
  models are identical.

### `@minicoder/triggerdev`

- Treat Trigger.dev as the concrete Workflow Layer runtime, not a place for business rules.
- Register only canonical task ID strings from `ALL_TASK_IDS`; no renames, aliases, or drift.
- The 9 planner/clarification `runImpl` functions call real core commands as of Phase 6
  (`packages/core/src/commands/handlers/{planning,clarification}/`); keep `start-next-feature` and
  `github-reconciliation` as payload-validated stubs until Phase 7/8 wire real core commands.
- Task wrappers may sequence commands but must not change command semantics. Only expected
  domain-level invalid outcomes should be converted into structured task results; operational and
  unexpected errors must propagate so Trigger.dev can mark failures and retry.
- Task files build `CommandEnvelope`s and call `TransactionalCommandExecutor` — never import
  `StateTransitionValidator`/`TransitionError` or compare state enums directly
  (`fitness/no-domain-logic-in-task-wrappers.test.ts` enforces this).
- `makeTaskRunner` and `MockTriggerRunner.run()` pass the resolved `DbClient` through to `runImpl`;
  tasks that invoke `PlannerAgentAdapter` receive the concrete adapter instance as an injected
  parameter, never importing a mock or reference implementation themselves.
- Preserve `assertSchemaReady()` so task containers fail fast on an unmigrated database.
- Keep Trigger.dev run metadata idempotent: retries reuse the original `triggerdev_runs` row.
- Deploy with `npx trigger.dev@4.4.6 deploy ...`; do not use `@latest`.
- Keep `TRIGGER_API_URL` explicit in deployment so CI does not silently target Trigger.dev Cloud.
- `loadTriggerConfig()` and `applyTriggerEnv()` are Phase 3 abstractions with no runtime call sites
  yet; they are wired as core-command-backed task execution arrives in later phases.

### Migrations

- Every schema change must have equivalent SQLite and PostgreSQL migration paths.
- Keep migration names aligned across dialects:

```text
NNNN_description.sqlite.sql
NNNN_description.postgres.sql
```

- Update both expected-table declarations when tables change:
  - `packages/migrations/src/index.ts`
  - `packages/migrations/src/runner.ts`
- Add or update migration tests for constraints, indexes, idempotency, and validation.
- When adding uniqueness constraints to existing tables, include dialect-appropriate duplicate
  cleanup that matches the stated retention policy before creating the constraint.
- Use portable identifiers generated by the application.
- Store timestamps in UTC. Current SQLite migrations use ISO-8601 `TEXT`; PostgreSQL uses
  `TIMESTAMPTZ`.
- Do not place ad hoc dialect-specific DDL outside the migration layer.

### CLI

- Keep CLI handlers thin; delegate behavior to package APIs or runners.
- Preserve non-zero exit codes on failure.
- Guard destructive operations with explicit confirmation and environment/authorization checks as
  the relevant phase introduces them.
- `db reset` is destructive and requires both `--yes` and
  `--env <development|test|ci>`. The runner also rejects a non-safe `APP_ENV` or `NODE_ENV`.
- Never run `db reset` against an unknown, shared, or production database. Use a disposable
  database and verify the configured database identifier before invoking it.
- The `minicoder state` command group is Phase 4 database-backed tooling. `inspect`, `validate`,
  `doctor`, `reconcile`, `export-diagnostics`, and `repair` are implemented against the configured
  database. `state repair` requires `--project`, emits a time-boxed token on dry run, applies
  scoped orphaned-run repairs transactionally, and writes a `workflow_events` audit record.
- `state reconcile --project` is project-scoped for project-owned resources; global outbox/inbox
  queue reconciliation requires explicit `--all`.
- `db seed`, `db snapshot`, and `db restore` are SQLite-only development/CI helpers. `db seed` and
  `db restore` reject production `APP_ENV`/`NODE_ENV`; PostgreSQL fixture loading should use
  `pg_restore` or a purpose-built seed script.
- `github simulate-*` commands are development/test/CI helpers that insert synthetic inbox events
  and reject production `APP_ENV`/`NODE_ENV`.
- The `minicoder test` group is implemented: `unit` runs non-integration Vitest files,
  `integration` runs `*.integration.test.ts` files, `system` runs all registered scenarios, and
  `scenario <name>` runs one registered scenario.
- The `minicoder trigger` command group exists. `trigger validate` is functional and reports the
  registered task IDs; `list-runs` and `inspect-run` are read-only placeholder JSON; operational
  commands (`deploy`, `drain-queue`, `cancel-run`, `replay-run`, `reset-dev`, `reconcile`) exit
  non-zero as not implemented until live API wiring lands.
- Destructive trigger reset scaffolding requires `--yes` and `--env <development|test|ci>` and
  rejects unsafe `APP_ENV`/`NODE_ENV` before reaching the not-implemented path.
- The glossary lists the target CLI surface. Verify a command is implemented before documenting it
  as currently available.

## Domain and Data Conventions

- Use exact canonical state and role tokens; do not invent aliases or near-matches.
- Feature IDs use `FR-<zero-padded-int>`, such as `FR-002`.
- Feature branches use `minicoder/FR-<n>`.
- The GitHub review-gate status check is `minicoder/review-gate`.
- All 15 canonical Trigger.dev task IDs are exact strings, no renaming/abbreviation permitted
  (`ALL_TASK_IDS`): `ingest-specification`, `planning-readiness-assessment`,
  `start-clarification`, `record-clarification-answer`, `complete-clarification`,
  `generate-implementation-plan`, `generate-feature-backlog`, `validate-backlog`,
  `request-plan-approval`, `activate-approved-backlog`, `start-next-feature`,
  `github-reconciliation`, `export-plan`, `export-backlog`, and `import-backlog`.
- Persisted mutable entities use optimistic versions.
- Locks use monotonically increasing fencing tokens; stale-fence writes must be rejected.
- Outbox and inbox events contain both `payload` and `payload_schema_version`.
- Inbox processing must validate the current schema version before invoking a handler and must be
  deduplicated.
- Unknown event types are deferred with `next_retry_at`; they must not consume attempts or starve
  registered handlers.
- Adapter roles are the canonical six-role set from the glossary: planner, coder, reviewer,
  documentation, arbiter, and human.
- Adapter capability tokens use the canonical `domain:name` shape and deterministic sorted order.
- Agent run provenance is a Phase 5 immutable adapter/configuration snapshot; do not inflate it
  into final provider/model/cost/token metadata without the corresponding later-phase design.
- Adapter conformance results are append-only audit records. Read paths that need the latest result
  must use an explicit deterministic tie-breaker.
- Clarification sessions are assessment-scoped. Do not use "latest project clarification session"
  as a proxy for whether a specific readiness assessment is complete.
- Backlog validation is a hard planning gate: validation writes deterministic evidence to
  `implementation_plans`, backlog mutations clear that evidence, and approval must require the
  current evidence.
- Discovery work reuses `feature_requests` with `kind = "discovery"` and `executable = false`.
- `resumed` is an event, not an automation state.
- A CI failure never silently advances or merges.

When modifying states, schemas, or entities, keep these layers synchronized:

1. Canonical glossary and subsystem docs
2. TypeScript state/entity definitions
3. Both database dialects
4. Transition/validation logic
5. Tests and fixtures
6. CLI/API/UI representations, when implemented

## Security Rules

- Never commit secrets, tokens, credentials, `.env` files, database files, logs, or secret-bearing
  fixtures.
- Resolve secrets through the `SecretBackend` abstraction.
- Use `EnvSecretBackend` for local/single-node and CI environments. Supply values through an OS
  keychain, secret-manager CLI, Docker/CI injection, or another mechanism that exports environment
  variables.
- `ManagedSecretBackend` is currently a Phase 1 contract stub, not a working hosted backend.
- Do not introduce a plaintext `FileSecretBackend`; the canonical security specification explicitly
  rejects unencrypted secret files.
- Keep task payloads, context packs, logs, errors, artifacts, and agent summaries secret-free.
- Treat repository content, issue/PR text, review comments, CI logs, and specification inputs as
  untrusted data.
- Untrusted content cannot expand permissions, alter orchestration policy, or bypass merge gates.
- Provider credentials must be scoped to the adapter that needs them.
- Trigger.dev webhook payloads require `TRIGGERDEV_WEBHOOK_SECRET`; all secrets in
  `docker-compose.triggerdev.yml` use `${VAR:?message}` interpolation so Compose exits on missing
  or empty values.
- Hosted agent workspaces require isolated ephemeral checkouts, bounded diffs, least-privilege
  secrets, and default-deny egress.
- Production GitHub authentication uses a least-privilege GitHub App with verified webhook
  signatures; PAT use is local-development-only.

## Development Commands

Requirements:

- Node.js 20 or newer
- pnpm 9, matching CI

Install:

```bash
pnpm install --frozen-lockfile
```

If `pnpm` is not globally available, use a pnpm 9 Corepack invocation, for example:

```bash
corepack pnpm@9.15.9 install --frozen-lockfile
```

Primary checks:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Useful targeted commands:

```bash
pnpm vitest run packages/core/src/persistence/optimistic.test.ts
pnpm vitest run packages/core/src/config/secrets.test.ts
pnpm vitest run packages/core/src/statemachine/validator.test.ts
pnpm vitest run packages/core/src/commands/executor.test.ts
pnpm vitest run packages/migrations/src/runner.test.ts
pnpm vitest run packages/workflow/src/outbox/dispatcher.test.ts
pnpm vitest run packages/workflow/src/inbox/processor.test.ts
pnpm vitest run packages/workflow/src/locks/manager.test.ts
pnpm vitest run packages/testing/src/testing.test.ts
pnpm vitest run packages/triggerdev/src/triggerdev.test.ts
```

SQLite migration smoke test:

```bash
DB_DIALECT=sqlite DB_PATH=/tmp/minicoder-agent.db pnpm db:migrate
DB_DIALECT=sqlite DB_PATH=/tmp/minicoder-agent.db pnpm db:validate
```

Destructive reset smoke tests must use a disposable database and both confirmation guards:

```bash
APP_ENV=development DB_DIALECT=sqlite DB_PATH=/tmp/minicoder-agent-reset.db \
  pnpm tsx packages/migrations/src/runner.ts reset --yes --env development
```

PostgreSQL migration validation requires a disposable database:

```bash
DB_DIALECT=postgres DB_URL=postgresql://... pnpm db:migrate
DB_DIALECT=postgres DB_URL=postgresql://... pnpm db:validate
```

Phase 4 lifecycle and system-test smoke checks:

```bash
APP_ENV=ci DB_DIALECT=sqlite DB_PATH=:memory: pnpm tsx packages/cli/src/index.ts test system
pnpm tsx packages/cli/src/index.ts test unit
pnpm tsx packages/cli/src/index.ts test integration
APP_ENV=development DB_DIALECT=sqlite DB_PATH=/tmp/minicoder-agent.db \
  pnpm tsx packages/cli/src/index.ts state doctor
```

Trigger.dev task ID smoke check:

```bash
pnpm --filter @minicoder/triggerdev build
pnpm --filter @minicoder/cli build
pnpm tsx packages/cli/src/index.ts trigger validate
```

Do not substitute SQLite-only validation for a required cross-dialect check.

## Testing Expectations

- Add regression tests with behavior changes.
- Unit tests must be deterministic, hermetic, and network-free.
- Default tests must not call real LLM providers, mutate real GitHub repositories, or require
  human interaction.
- Integration and migration changes must be validated against both SQLite and PostgreSQL.
- Scenario fixtures under `packages/testing/src/fixtures/` are SQLite-only unless explicitly
  documented otherwise; do not use them as PostgreSQL portability evidence.
- `pnpm audit --prod --audit-level=high` is the CI production dependency gate. Full local
  `pnpm audit --audit-level=high` currently reports documented Vitest/Vite dev-only advisories;
  upgrade them when feasible rather than weakening runtime dependency checks.
- Never call `db.close()` in SQLite tests; `better-sqlite3` native finalizers can double-free after
  explicit close. `vitest.config.ts` uses `pool: 'forks'` to isolate test-file teardown.
- Use disposable databases and deterministic fixtures.
- Test failure paths, retries, idempotency, constraint enforcement, rollback, and stale-write
  rejection—not only happy paths.
- New architecture boundaries should receive fitness tests.
- Preserve the Vitest convention `packages/*/src/**/*.test.ts`. Use `*.integration.test.ts` for
  tests that should be selected by `minicoder test integration`.

For a phase-level change, satisfy the Definition of Done in `docs/06-implementation-plan.md`:
schema changes, appropriate tests, canonical doc updates, runbook/diagnostic updates where relevant,
and a runnable demonstration scenario.

## TypeScript and Style

- TypeScript is strict with `noUncheckedIndexedAccess`, `noImplicitReturns`, and
  `noFallthroughCasesInSwitch`.
- Avoid `any`; tests are the only configured exception.
- Prefix intentionally unused parameters with `_`.
- Avoid import cycles.
- Use `.js` suffixes for local TypeScript imports, matching the existing source convention.
- Preserve root `pnpm typecheck` ordering for packages whose `types` point to generated `dist/`:
  `core → persistence-sqlite → persistence-postgres → triggerdev → recursive --noEmit`.
- Prefer small functions and explicit domain types over loosely shaped objects.
- Formatting is controlled by Prettier:
  - semicolons
  - single quotes
  - trailing commas
  - 100-column width
  - two-space indentation
- Do not add dependencies unless the existing stack cannot reasonably solve the problem.

## Documentation Changes

- Preserve each canonical document's `Status`, `Supersedes`, `Version`, and `Last-updated` header.
- Introduce shared vocabulary in `docs/00-glossary-and-terms.md` first.
- Do not create a second phase plan; update `docs/06-implementation-plan.md`.
- Keep architecture language provider-neutral. Provider implementations are adapters, not core
  dependencies.
- Clearly distinguish target architecture from currently implemented behavior.
- If a change invalidates a summary in `README.md` or `CLAUDE.md`, update the summary too.
- After terminology changes, grep for stale tokens and removed command names.

## Change Workflow

1. Read the relevant canonical docs and current implementation.
2. Identify the implementation phase and package boundary.
3. Write or update tests that lock the intended behavior.
4. Make the smallest coherent change.
5. Synchronize docs, types, migrations, and tests where the change crosses those layers.
6. Run targeted tests first.
7. Run the full verification suite.
8. Review `git diff` for accidental generated files, secrets, database files, or unrelated edits.

Do not overwrite unrelated user changes. Prefer deletion and reuse over new abstractions. Keep diffs
small, reviewable, and reversible.

## Completion Checklist

Before reporting completion:

- The change matches canonical vocabulary and architecture.
- Current behavior and target behavior are not conflated.
- Package boundaries remain intact.
- Both database dialects were updated when required.
- Tests cover success and meaningful failure paths.
- `test`, `typecheck`, `lint`, `format:check`, and `build` pass, or any unavailable check is
  explicitly reported.
- No secrets, generated artifacts, database files, or unrelated changes are present.
- Documentation and operations guidance are updated where required.
