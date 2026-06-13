# MiniCoder — Claude Code Project Guide

## What This Repository Is

MiniCoder is an **Agentic Software Development Orchestration System** that converts user intent or
system specifications into a clarified, approved, sequential implementation backlog, then
orchestrates feature-branch development, pull requests, structured reviews, fixes, merge gates,
and final design documentation.

This repository contains the **Phase 1–2 implementation**: monorepo skeleton, persistence
abstraction (SQLite + PostgreSQL), 43-table initial schema, migration tooling, config/secrets
backends, database lifecycle CLI (`minicoder db`), CI (Phase 1); and full state-machine / command
layer with state-transition validator, transactional idempotent commands, outbox/inbox dispatching,
workflow locks with fencing tokens, execution lanes, local auth, secret-redaction tests, and the
`minicoder state` CLI (Phase 2). Canonical specification documents live under `docs/`.

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

All work goes on branch `claude/sleepy-gauss-p1y6c0`. Always push with:

```bash
git push -u origin claude/sleepy-gauss-p1y6c0
```

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

## Cross-Dialect Testing (Mandatory)

The integration test suite and migration validation **must** run against both SQLite and PostgreSQL
as a matrix. This is a CI requirement, not optional. The security scan
(pnpm audit/OSV + gitleaks + semgrep) also runs in CI.

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

`state repair` requires two steps:

1. `minicoder state repair --dry-run` — previews changes, prints a single-use confirmation token.
2. `minicoder state repair --apply --confirmation <token>` — executes; token is time-boxed and
   single-use.

`state purge` does not exist. Irreversible maintenance uses only the guarded `repair --apply` path.

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
