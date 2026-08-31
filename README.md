# MiniCoder

**MiniCoder — Agentic Software Development Orchestration System.**

MiniCoder converts user intent or system specifications into a clarified, approved, sequential
implementation backlog, then orchestrates feature-branch development, pull requests, structured
reviews, fixes, merge gates, and final design documentation. It is designed to be auditable,
deterministic, cost-aware, safe, and fully testable without human intervention.

A specification goes in; a clarification workflow resolves ambiguity; an approved backlog is
generated; and then, one feature at a time, an AI coder writes the code, opens a pull request, an
AI reviewer reviews it, a fix loop resolves findings, a policy-driven merge gate approves the
merge, and (once every feature is merged) an AI documentation adapter drafts a final design
document for human approval. Humans stay in the loop at the decisions that matter — plan approval,
disagreement resolution, merge authorization, budget overrides, and design-document sign-off — and
everything else runs unattended.

New to operating a deployment? Start with **[`USER-MANUAL.md`](USER-MANUAL.md)** for setup
instructions, a full CLI command reference, and an end-to-end walkthrough of taking a project from
specification to a merged, documented result.

## Documentation (canonical)

The authoritative specification lives entirely under [`docs/`](docs/). Read in order:

| Document                                                                                         | Purpose                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/00-glossary-and-terms.md`](docs/00-glossary-and-terms.md)                                 | Single source of truth for the state machines/tokens, agent roles, user/auth roles, adapter names, identifiers, deployment profiles, the CLI surface, and the locked tech stack. |
| [`docs/01-system-specification.md`](docs/01-system-specification.md)                             | Canonical architecture: scope, principles, subsystems, data design, API conventions, merge policy + gate evidence, and Project Acceptance Validation.                            |
| [`docs/02-bootstrap-planner-clarification.md`](docs/02-bootstrap-planner-clarification.md)       | Bootstrap Planner, readiness assessment, the Clarification Workflow, and the discovery backlog.                                                                                  |
| [`docs/03-agent-adapter-architecture.md`](docs/03-agent-adapter-architecture.md)                 | Vendor-neutral agent adapter roles, capabilities, conformance, and the Adapter Execution Contract (workspaces, I/O schemas, retries, error taxonomy).                            |
| [`docs/04-testing-validation-state-lifecycle.md`](docs/04-testing-validation-state-lifecycle.md) | Automated testing (incl. cross-dialect), validation, state-lifecycle tooling, and operations runbooks.                                                                           |
| [`docs/05-ui-specification.md`](docs/05-ui-specification.md)                                     | Ink Text UI and Next.js Web UI, including state-health and admin views.                                                                                                          |
| [`docs/06-implementation-plan.md`](docs/06-implementation-plan.md)                               | The single canonical 18-phase implementation plan, with per-phase acceptance criteria and a global Definition of Done.                                                           |
| [`docs/07-security-and-secrets.md`](docs/07-security-and-secrets.md)                             | Security and secrets: secret backend, GitHub App auth, workspace sandboxing/egress, payload hygiene/residency, prompt-injection, untrusted code.                                 |

## Precedence rule

- Everything under [`docs/`](docs/) is **canonical**. Each file carries a `Status: Canonical`
  header listing the documents it supersedes.
- Anything **outside** `docs/` (including this README and `USER-MANUAL.md`) is non-authoritative
  summary. If a summary and a `docs/` file disagree, the `docs/` file wins.
- Within `docs/`, shared vocabulary (states, roles, adapter names, CLI commands) is defined once in
  `00-glossary-and-terms.md`; other documents reference it rather than redefining it.

## Architecture at a glance

- **Database-authoritative state** behind a persistence abstraction — **one architecture, two state
  stores**: SQLite (local/single-node) and PostgreSQL (hosted/team).
- **A Workflow Layer for durable workflow execution** — an in-repo, DB-backed task queue
  (`packages/triggerdev/`); tasks are thin, idempotent wrappers over Orchestrator Core commands.
  Scaling is "run more `minicoder tasks worker` processes against the same database," not a
  separate backend choice.
- **The linked SCM provider is repository truth**; webhooks are the primary event source, with
  scheduled reconciliation as the fallback/repair path. GitHub is the original and most complete
  implementation; Gitea and GitLab are also shipped behind the same provider-neutral interface
  (docs/06 §Phase 18). **`./scripts/start-minicoder.sh` defaults to SQLite + a local, docker-
  compose-managed Gitea instance** so a fresh checkout is usable quickly with no external accounts
  to sign up for; PostgreSQL/GitHub/GitLab remain fully supported via `--db=postgres`/
  `--scm=github`/`--scm=gitlab` for more complex setups (see `USER-MANUAL.md` §3).
- **Sequential execution is a policy** (locks/lanes with fencing tokens), not a schema limitation —
  one feature is worked on per project at a time, by design.
- **Vendor-neutral agent adapters** (planner, coder, reviewer, arbiter, documentation, human) run
  behind injected provider seams, isolated in sandboxed, default-deny-egress workspaces where code
  actually executes.
- **Security is first-class** — secret backend, GitHub App auth, payload hygiene/data residency,
  and prompt-injection handling are part of the design, not an afterthought.
- **Cost-aware** — per-scope budgets with soft/hard gates, forecasting, and a review-loop circuit
  breaker.
- **Fully automated testing** (including a cross-dialect SQLite/PostgreSQL matrix) and
  state-lifecycle diagnostics/repair tooling are foundational, not bolted on.
- **A single Fastify Orchestrator API** is the one network-facing surface: it dispatches the same
  command layer the CLI and Workflow Layer tasks use — no arbitrary state-mutation endpoints.
- **The Ink Text UI and the Next.js Web UI both talk to that API over HTTP only** — no direct
  database access, no duplicated authorization logic; the backend is the sole enforcement point for
  every action either UI renders a control for. The Web UI keeps its API credential server-side
  only (no client-exposed key) and is intended for trusted/internal deployment until real end-user
  auth ships.

## Deployment note

`packages/web` holds one server-side Orchestrator API credential shared by every browser visitor —
there is no per-end-user session/auth layer yet. Deploy it only on a trusted/internal network (VPN,
internal load balancer, or an authenticating reverse proxy) until real end-user auth ships; see
[`docs/07-security-and-secrets.md`](docs/07-security-and-secrets.md) §4.

Technology stack and the full term set are in
[`docs/00-glossary-and-terms.md`](docs/00-glossary-and-terms.md).
