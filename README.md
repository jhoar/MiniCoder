# MiniCoder

**MiniCoder — Agentic Software Development Orchestration System.**

MiniCoder converts user intent or system specifications into a clarified, approved, sequential
implementation backlog, then orchestrates feature-branch development, pull requests, structured
reviews, fixes, merge gates, and final design documentation. It is designed to be auditable,
deterministic, cost-aware, safe, and fully testable without human intervention.

This repository contains the **Phase 1–14 implementation** of MiniCoder — the monorepo skeleton,
persistence abstraction (SQLite + PostgreSQL), initial schema, migration tooling,
config/secrets backends, database lifecycle CLI, and CI (Phase 1); full state-machine / command
layer, transactional idempotent commands, outbox/inbox dispatching, workflow locks, and local auth
(Phase 2); Workflow Layer harness with Trigger.dev v4 Docker Compose stack and `minicoder trigger`
CLI scaffold (Phase 3); mock agent adapter library with six role implementations and per-adapter
scenario test suites (Phase 4); the Agent Adapter Foundation — role interfaces, capability
model, AdapterRegistry, AgentRunRecorder, and conformance test framework (Phase 5); the
Bootstrap Planner, Readiness, and Clarification implementation — specification ingestion, planner-
adapter-backed readiness assessment, the clarification workflow and its circuit breaker, plan and
feature-backlog generation and validation, approval and activation, and artifact export/import, all
wired to real Trigger.dev tasks (Phase 6); the GitHub Webhooks, Integration, and Reconciliation
implementation — the webhook receiver, provider-SDK-free `GitHubClient` seam, and the shared
reconciliation algorithm driving both webhook-triggered inbox handlers and the scheduled
fallback (Phase 7); the Execution Orchestrator implementation — dependency-ordered sequential
feature selection, the `start-next-feature` Trigger.dev task, pause/resume automation control, and
a minimal budget-gate primitive with soft/hard limit enforcement (Phase 8); the Reference Coder
Adapter implementation — `CodexCoderAdapter` (an injected code-generation seam, runner-agnostic git
orchestration, bounded-diff enforcement), ephemeral sandbox container isolation, the `run-coder`
Trigger.dev task bridging coding through pull-request creation, and cost/context-pack/tool-operation
provenance recording (Phase 9); the Reference Reviewer Adapter and Review/Fix Loop implementation —
`ClaudeReviewerAdapter` (a sandbox-free, read-only review seam), the `run-review` Trigger.dev task
driving the review/fix cycle, and the aggregate fix-attempt circuit breaker (Phase 10); the
Disagreement, Arbiter, and Human Escalation implementation — repeated-unresolved-finding detection,
inline Arbiter adjudication, the five `human_required` exit commands and their `minicoder human ...`
CLI surface, and the terminal `skipped` feature state (Phase 11); the Merge Gate and Branch
Protection implementation — the merge-policy engine, real approve/merge/record-failure command
handlers, the `minicoder/review-gate` GitHub status check, the `run-merge-gate` Trigger.dev task, and
`minicoder merge merge-if-ready` (Phase 12); and the Orchestrator API implementation — a
Fastify-based HTTP API exposing read models, dispatching existing core commands (generic dispatch,
a dedicated `merge-if-ready` route, and Trigger.dev task-enqueue routes), mounting the GitHub webhook
receiver, and publishing a hand-authored OpenAPI 3.1 contract with route-registration-time
conformance enforcement — a static API-key auth model, claim-first HTTP route idempotency for
routes spanning an external side effect, and `minicoder api serve` (Phase 13); and the Ink Text UI
implementation — the `@minicoder/tui` package and its fourteen `minicoder {status,plan,
clarification,features,active,runs,findings,disagreements,costs,artifacts,adapters,design-doc,
pause,resume}` CLI commands, all calling the Orchestrator API over HTTP only (Phase 14).
Specification documents live under `docs/`.

## Documentation (canonical)

The authoritative specification lives entirely under [`docs/`](docs/). Read in order:

| Document                                                                                         | Purpose                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`docs/00-glossary-and-terms.md`](docs/00-glossary-and-terms.md)                                 | Single source of truth for the state machines/tokens, agent roles, user/auth roles, adapter names, identifiers, deployment profiles + backend tiers, the CLI surface, and the locked tech stack. |
| [`docs/01-system-specification.md`](docs/01-system-specification.md)                             | Canonical architecture: scope, principles, subsystems, data design, API conventions, merge policy + gate evidence, and Project Acceptance Validation.                                            |
| [`docs/02-bootstrap-planner-clarification.md`](docs/02-bootstrap-planner-clarification.md)       | Bootstrap Planner, readiness assessment, the Clarification Workflow, and the discovery backlog.                                                                                                  |
| [`docs/03-agent-adapter-architecture.md`](docs/03-agent-adapter-architecture.md)                 | Vendor-neutral agent adapter roles, capabilities, conformance, and the Adapter Execution Contract (workspaces, I/O schemas, retries, error taxonomy).                                            |
| [`docs/04-testing-validation-state-lifecycle.md`](docs/04-testing-validation-state-lifecycle.md) | Automated testing (incl. cross-dialect), validation, state-lifecycle tooling, and operations runbooks.                                                                                           |
| [`docs/05-ui-specification.md`](docs/05-ui-specification.md)                                     | Ink Text UI and Next.js Web UI, including state-health and admin views.                                                                                                                          |
| [`docs/06-implementation-plan.md`](docs/06-implementation-plan.md)                               | The single canonical 18-phase implementation plan, with per-phase acceptance criteria and a global Definition of Done.                                                                           |
| [`docs/07-security-and-secrets.md`](docs/07-security-and-secrets.md)                             | Security and secrets: secret backend, GitHub App auth, workspace sandboxing/egress, payload hygiene/residency, prompt-injection, untrusted code.                                                 |

## Precedence Rule

- Everything under [`docs/`](docs/) is **canonical**. Each file carries a `Status: Canonical`
  header listing the documents it supersedes.
- Anything **outside** `docs/` (including this README's prose) is non-authoritative summary. If a
  summary and a `docs/` file disagree, the `docs/` file wins.
- Within `docs/`, shared vocabulary (states, roles, adapter names, CLI commands) is defined once in
  `00-glossary-and-terms.md`; other documents reference it rather than redefining it.

## Status Legend

`Status: Canonical` — current, authoritative.
A previous generation of split specifications (an original set plus a partial `_testing_updated`
overlay) was reconciled and replaced by this `docs/` set; those files are removed but remain in git
history.

## Architecture at a Glance

- **Database-authoritative state** behind a persistence abstraction — **one architecture, two state
  stores**: SQLite (local/single-node) and PostgreSQL (hosted/team).
- **Workflow Layer** for durable workflow execution (implemented by Trigger.dev); tasks are thin,
  idempotent wrappers over Orchestrator Core commands. The execution backend is a separate axis with
  three drop-in tiers — **self-host single-node (default)**, self-host HA cluster, and Trigger.dev
  Cloud — swappable without architectural change.
- **GitHub** is repository truth; **webhooks are primary**, scheduled reconciliation is the
  fallback.
- **Sequential execution is a policy** (locks/lanes with fencing tokens), not a schema limitation.
- **Vendor-neutral agent adapters** run in isolated, sandboxed, default-deny-egress workspaces; no
  dependency on any specific provider.
- **Security is first-class** — secret backend, GitHub App auth, payload hygiene/data-residency, and
  prompt-injection handling, established in the earliest phases.
- **Cost-aware** — per-scope budgets with soft/hard gates and a review-loop circuit breaker.
- **Fully automated testing** (including a cross-dialect SQLite/PostgreSQL matrix) and
  state-lifecycle tooling are foundational.
- **A single Fastify Orchestrator API** is the one network-facing surface: it dispatches the same
  command layer the CLI and Workflow Layer tasks use — no arbitrary state-mutation endpoints.
- **The Ink Text UI talks to that API over HTTP only** — no direct database access, no duplicated
  authorization logic; the backend is the sole enforcement point for every command it renders a
  UI for.

Technology stack and the full term set are in
[`docs/00-glossary-and-terms.md`](docs/00-glossary-and-terms.md).
