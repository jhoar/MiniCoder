# MiniCoder — Security and Secrets Specification

> Status: Canonical
> Supersedes: (new — extracts and expands `01-system-specification.md` §15)
> Version: 1.0.6
> Last-updated: 2026-07-06

This document is the authoritative security and secrets specification. It expands the principles in
[`01-system-specification.md`](01-system-specification.md) §15 and complements the Adapter Execution
Contract in [`03-agent-adapter-architecture.md`](03-agent-adapter-architecture.md) §11. Terms and
roles are defined in [`00-glossary-and-terms.md`](00-glossary-and-terms.md).

MiniCoder lets agents modify repositories, run tests, push branches, and inspect project context.
Security is therefore a **design property, not a convention**: secrets are isolated, workspaces are
sandboxed, and untrusted input is treated as hostile.

## 1. Security Foundation Is Early

The security foundation is established in implementation **Phases 1–3**, not deferred to the API
phase: the config/secrets abstraction, environment modes, audit actor identity, local
authentication, webhook-secret management, and secret-redaction tests all exist before GitHub
webhooks (Phase 7) or real coder adapters (Phase 9) run.

## 2. Secrets Management

- **Secret backend abstraction.** Secrets are resolved through a `SecretBackend` interface
  (`get`/`set`/`delete`/`list`): `EnvSecretBackend` (environment variables) for local/single-node;
  `ManagedSecretBackend` (cloud KMS/secret manager) for hosted/team. Code never hard-codes secrets.
  A plaintext `FileSecretBackend` was considered and rejected: reading unencrypted JSON from disk
  violates the "encrypted at rest" invariant below. Local developers use OS keychain, a secrets
  manager CLI exporting env vars, or Docker/CI secrets injection — never a committed plaintext file.
  `ManagedSecretBackend` (`packages/core/src/config/secrets.ts`) is a plain `fetch`-based HTTP
  client against a secrets-manager-compatible REST facade, configured via `MANAGED_SECRETS_URL`/
  `MANAGED_SECRETS_API_KEY` (or an injected `{baseUrl, apiKey}`) — the same "provider-neutral,
  plain-`fetch`" seam pattern used for `HttpCodeGenerationProvider`/`HttpReviewProvider`. It
  deliberately does not read or write MiniCoder's own database: backing it with an in-app
  `secrets` table was considered and rejected, since it would put plaintext-adjacent secret
  material inside application state, directly contradicting "no plaintext at rest in MiniCoder
  state" below. Point it at a facade in front of the actual KMS/secret manager (HashiCorp Vault's
  KV v2 REST API, a thin AWS Secrets Manager/Azure Key Vault proxy, or an internal secrets
  service); encryption at rest and in transit (TLS) is that facade's responsibility.
- **No plaintext at rest in MiniCoder state.** Secrets are never stored in the database, never
  written to Markdown artifacts, and never placed in `agent_context_packs` or logs.
- **Per-adapter scoping.** Each adapter receives only the credentials it needs; the orchestrator is
  not given every provider token.
- **Redaction.** A redaction layer scrubs secrets from logs, structured outputs, error summaries,
  and observability records; redaction is covered by tests (conformance + integration).
- **Encryption.** Secrets are encrypted at rest in the chosen backend and in transit (TLS); any
  encryption keys live in the secret backend, not the application database.

## 3. GitHub Authentication Model

- **GitHub App preferred over PAT.** Production deployments use a **GitHub App** with installation
  tokens (short-lived, least-privilege); a PAT is acceptable only for local/single-node development.
- **Least-privilege permissions:** contents (read/write), pull requests (read/write), checks
  (read/write), statuses (read/write), metadata (read), and webhooks — nothing broader.
- **Webhook signatures.** All inbound webhook deliveries are signature-verified (HMAC) before inbox
  persistence; unsigned/invalid deliveries are rejected and audited.

## 4. Authentication, Sessions, and Authorization

- **Local mode.** Local auth identifies an actor for audit and role enforcement without external
  identity infrastructure.
- **Hosted mode.** OAuth (or equivalent SSO) issues sessions; sessions are short-lived and revocable.
- **Roles.** `viewer`, `operator`, `approver`, `admin` (canonical in
  [`00-glossary-and-terms.md`](00-glossary-and-terms.md) §4.4). Approver/admin is required for plan
  activation, budget override, disagreement resolution, merge-if-ready, final design-document
  approval, and guarded state-lifecycle/destructive actions.
- **Authorization is backend-enforced.** UIs never enforce authorization themselves.
- **Client-side API credential (Phase 14 — Ink Text UI).** The Text UI is an HTTP client of the
  Orchestrator API, not an in-process caller — it holds exactly one raw API key value and sends it
  as `Authorization: Bearer <key>`. It is configured via `MINICODER_API_URL` (base URL, defaults to
  `http://localhost:4000`) and `MINICODER_API_KEY` (the raw key; required, singular) — deliberately
  distinct from the server-side `MINICODER_API_KEYS` (plural, a JSON array of key configs consumed
  by `ApiKeyProvider`), so the two are never confused. `MINICODER_API_KEY` is env-var-only: the TUI
  never writes it to a config file or any other on-disk location, preserving "no plaintext at rest"
  for a credential the TUI merely holds rather than issues. The TUI has no `/whoami`-independent
  role model of its own — it calls `GET /whoami` to display which role/actorKind the configured key
  resolves to, and otherwise simply surfaces whatever `AuthorizationError`/403 the API returns,
  never re-implementing the role/rank check client-side.

## 5. Token Rotation and Audit Retention

- **Rotation.** GitHub App keys/installation tokens, provider tokens, and webhook signing secrets
  are rotatable with zero stored plaintext and no downtime; rotation is a documented runbook
  ([`04-testing-validation-state-lifecycle.md`](04-testing-validation-state-lifecycle.md) §11).
- **Webhook secret rotation overlap.** GitHub supports only a brief dual-secret window, so during a
  bounded overlap MiniCoder verifies inbound signatures against the **current and previous** signing
  secret, then retires the previous secret once the window closes.
- **Audit.** Human approvals, destructive commands, budget overrides, and security-relevant actions
  are recorded with actor identity, role, and correlation ID, and retained per a defined retention
  policy.

## 6. Workspace Sandboxing and Egress

- **Isolated, ephemeral workspaces** per agent run (Adapter Execution Contract §11.1): fresh
  checkout, one branch per run, torn down afterward.
- **Default-deny egress.** Workspace network access is denied by default and allow-listed only for
  required endpoints (the assigned provider, GitHub). This contains exfiltration and
  prompt-injection-driven callbacks.
- **Dependency provisioning under default-deny egress.** Because builds and `can_run_tests` use
  `pnpm`/Node and would otherwise need public registry lookups, the workspace runner resolves
  dependencies **without** opening general egress: it uses a **pre-baked base image layer** and/or a
  **read-only bind-mounted, pre-indexed global `pnpm` store**, or routes registry traffic
  **exclusively** through an authenticated **internal package proxy/mirror**. The public npm
  registry is never directly reachable from the sandbox; the proxy/mirror is the only allow-listed
  package endpoint.
- **Local egress variant.** Standing up an authenticated internal mirror is heavy for the
  local/single-node profile. Locally, a **pre-baked `pnpm` store** plus an **optional, clearly
  labelled "local dev egress allow-list"** (registry hosts only) is permitted; this allow-list is
  **forbidden in hosted/team profiles**, which require the pre-baked store and/or internal
  proxy/mirror. A feature needing a dependency absent from the pre-baked store cannot be implemented
  under strict default-deny without the mirror.
- **Bounded changes.** File changes are confined to the workspace, under a maximum diff size, and
  rejected on disallowed paths.
- **No secret-bearing workflows on untrusted code.** CI/agent workflows that hold secrets must not
  run against untrusted fork code.

**Phase 9 implementation status.** This section was policy-only through Phase 8; Phase 9
(`packages/adapters-coder`, `infra/docker-compose.coder-sandbox.yml`) gives it a real
implementation for the first time:

- **Real, as of Phase 9:** one ephemeral, non-root, capability-dropped (`CapDrop: ['ALL']`),
  read-only-root-filesystem Docker container per coder run (`CoderSandbox`, via `dockerode`
  against a narrowly-scoped `coder-sandbox-docker-proxy`), attached only to an `internal: true`
  Docker network with no direct route to the internet; the only egress path out of that container
  is an allow-list forward proxy (`coder-sandbox-egress-proxy`, `tinyproxy` with
  `FilterDefaultDeny yes`) permitting GitHub hosts (the sandbox does git clone/commit/push); the
  container is always removed in a `finally` (success, failure, or cancellation); bounded-diff/
  disallowed-path enforcement runs as application logic (`diff-guard.ts`) on top of — not instead
  of — this container isolation; one branch per run, never force-pushed.
- **Deliberate trust-boundary split: the LLM code-generation call is host-side, not
  sandboxed.** `CodexCoderAdapter.run()` starts the sandbox for clone/list-files/write/commit/push,
  but calls `CodeGenerationProvider.generate()` (a plain `fetch`, `HttpCodeGenerationProvider`) in
  the Trigger.dev task process itself — the _same_ process that holds `CODE_GEN_API_KEY` and
  `GITHUB_TOKEN` as environment variables. This is intentional, not an oversight: the sandbox
  container is the untrusted-code-execution boundary (it runs `pnpm install`/`pnpm test` against
  LLM-generated files and, eventually, project-supplied test/build scripts), so `CODE_GEN_API_KEY`
  must never be reachable from inside it — injecting the LLM credential into the same container
  that executes generated code would let a compromised dependency or malicious generated test
  exfiltrate it. The egress proxy's `CODE_GEN_ALLOWED_HOST` allow-list entry
  (`infra/docker/coder-sandbox/egress-proxy/filter.txt`) is consequently unused by any call the
  sandbox container makes today — it exists for a future variant where code generation is invoked
  from inside the sandbox (e.g. a self-hosted model reachable without a long-lived credential), not
  as a claim that the current `HttpCodeGenerationProvider` call is proxied through it. Host-process
  egress for the code-generation call is governed by ordinary deployment-network egress controls,
  not by this sandbox's proxy — document and secure that host-process network path the same way
  any other outbound API call from the Workflow Layer's worker process is secured.
- **Aspirational, not yet daemon-verified:** the sandbox stack was written and syntax-validated
  (`docker compose config`) but has not been exercised against a live Docker daemon in this
  repository's CI — the implementation session had no reachable daemon (see docs/06 Phase 9
  "Deviations from the original plan"). A Docker-daemon-gated integration test proving egress
  denial actually blocks a disallowed host while allowing GitHub/the LLM host remains to be added.
  The "internal package proxy/mirror" and "local dev egress allow-list" variants described above
  for dependency provisioning are not yet built — the pre-baked sandbox image
  (`infra/docker/coder-sandbox/Dockerfile`) installs Node/pnpm/git at build time, but a read-only
  bind-mounted pnpm store is not yet wired into the compose stack.

## 6a. Workflow-Layer Payload Hygiene

- Task payloads carry **references and IDs, never secrets** and never raw secret-bearing material.
- Context packs (already secret-free) are the only sanctioned source of task input.
- **Data residency:** self-host keeps payloads in-boundary; **Trigger.dev Cloud transmits payloads
  to managed infrastructure**. Deployments with data-residency constraints must use a self-host
  backend. This is a **security/compliance** decision, not merely a deployment-config decision (see
  `00-glossary-and-terms.md` §6.2, `01-system-specification.md` §14).
- The "no secret in task payloads" rule is enforced as a Phase 2 architectural fitness test (see
  `06-implementation-plan.md` Phase 2). Implemented at:
  `packages/core/src/fitness/no-secret-in-task-payloads.test.ts` (RF-12). The test verifies that
  event payload Zod schemas contain no secret-bearing field names, and that `SecretRedactor` is
  applied via `defaultRedactor.redactObject()` before every outbox payload is serialized
  (`packages/core/src/commands/helpers.ts`).

## 6b. Trigger.dev Webhook-Secret Management (Phase 3)

MiniCoder uses two secrets when integrating with the self-hosted Trigger.dev server:

- **`TRIGGERDEV_API_KEY`** — authenticates the MiniCoder application and task containers to the
  Trigger.dev webapp API. Set as `TRIGGER_ACCESS_TOKEN` in the Docker Compose environment and
  injected into task containers at runtime. Must be treated as a credential: stored only in the
  secret backend, never committed to source control or included in task payloads.
- **`TRIGGERDEV_WEBHOOK_SECRET`** — verifies that inbound payloads from the Trigger.dev server
  have not been tampered with (see rotation procedure below).

`TRIGGERDEV_WEBHOOK_SECRET` must be:

- **Stored only in the secret backend** (`EnvSecretBackend` or `ManagedSecretBackend`), never
  committed to source control or included in task payloads.
- **Set in both the Trigger.dev webapp** (`TRIGGER_WEBHOOK_SECRET` env var in
  `infra/docker-compose.triggerdev.yml`) and the **MiniCoder application** (`TRIGGERDEV_WEBHOOK_SECRET`
  env var, accessed via `ConfigBackend`).
- **At least 32 bytes of cryptographic randomness**: `openssl rand -hex 32`

**Rotation procedure** (zero-downtime):

1. Generate a new secret: `openssl rand -hex 32`
2. Configure MiniCoder to accept both current and new secrets simultaneously (brief overlap window).
3. Update `TRIGGER_WEBHOOK_SECRET` in the Trigger.dev webapp and restart `triggerdev-webapp`.
4. Update `TRIGGERDEV_WEBHOOK_SECRET` in the MiniCoder secret backend.
5. Remove the previous secret from the MiniCoder overlap window after the next successful delivery.
6. Record the rotation in the audit log.

See `04-testing-validation-state-lifecycle.md` §11 (Phase 3 runbook) for the full step-by-step
procedure including pre-conditions and rollback path.

## 7. Prompt-Injection and Untrusted Content

MiniCoder treats repository content, PR descriptions, review comments, issue bodies, CI logs, and
specification inputs as **untrusted**:

- Untrusted content is never allowed to escalate adapter tool permissions, alter policy, or expand
  secret exposure.
- Instructions embedded in untrusted content do not change orchestration behavior; only signed
  commands through the API and human approvals do.
- Outputs derived from untrusted content remain subject to the merge gate, review findings, and
  human approval — there is no automated bypass.

## 8. Acceptance Criteria

Satisfied when: secrets resolve only through the backend abstraction with no plaintext in
database/artifacts/logs; redaction is test-covered; GitHub uses a least-privilege App with verified
webhook signatures; roles are backend-enforced; token rotation and audit retention are documented
runbooks; agent runs execute in sandboxed, default-deny-egress, ephemeral workspaces with bounded
diffs; and untrusted content cannot escalate permissions or bypass the merge gate.
