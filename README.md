# MiniCoder

**MiniCoder — Agentic Software Development Orchestration System.**

MiniCoder converts user intent or system specifications into a clarified, approved, sequential
implementation backlog, then orchestrates feature-branch development, pull requests, structured
reviews, fixes, merge gates, and final design documentation. It is designed to be auditable,
deterministic, cost-aware, safe, and fully testable without human intervention.

This repository currently contains the **specification set** for MiniCoder (no application code
yet).

## Documentation (canonical)

The authoritative specification lives entirely under [`docs/`](docs/). Read in order:

| Document | Purpose |
|---|---|
| [`docs/00-glossary-and-terms.md`](docs/00-glossary-and-terms.md) | Single source of truth for state names, roles, adapter names, deployment profiles, and the CLI surface. |
| [`docs/01-system-specification.md`](docs/01-system-specification.md) | Canonical architecture: scope, principles, subsystems, data design, API, merge policy, security. |
| [`docs/02-bootstrap-planner-clarification.md`](docs/02-bootstrap-planner-clarification.md) | Bootstrap Planner, readiness assessment, and the Clarification Workflow. |
| [`docs/03-agent-adapter-architecture.md`](docs/03-agent-adapter-architecture.md) | Vendor-neutral agent adapter roles, capabilities, conformance, and naming. |
| [`docs/04-testing-validation-state-lifecycle.md`](docs/04-testing-validation-state-lifecycle.md) | Automated testing, validation, and state-lifecycle management requirements. |
| [`docs/05-ui-specification.md`](docs/05-ui-specification.md) | Ink Text UI and Next.js Web UI, including state-health and admin views. |
| [`docs/06-implementation-plan.md`](docs/06-implementation-plan.md) | The single canonical 18-phase implementation plan with acceptance criteria. |
| [`docs/07-security-and-secrets.md`](docs/07-security-and-secrets.md) | Security and secrets: secret backend, GitHub App auth, sandboxing, egress, prompt-injection, untrusted code. |

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

- **One architecture, two deployment profiles** — local/single-node (SQLite) and hosted/team
  (PostgreSQL), behind a persistence abstraction.
- **Trigger.dev** (Cloud) for durable workflow execution; tasks are thin, idempotent wrappers over
  Orchestrator Core commands.
- **GitHub** is repository truth; **webhooks are primary**, scheduled reconciliation is the
  fallback.
- **Sequential execution is a policy** (locks/lanes), not a schema limitation.
- **Vendor-neutral agent adapters**; no dependency on any specific provider.
- **Fully automated testing** and state-lifecycle tooling are foundational.

Technology stack and the full term set are in
[`docs/00-glossary-and-terms.md`](docs/00-glossary-and-terms.md).
