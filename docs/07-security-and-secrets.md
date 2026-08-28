# MiniCoder — Security and Secrets Specification

> Status: Canonical
> Supersedes: (new — extracts and expands `01-system-specification.md` §15)
> Version: 1.2.0
> Last-updated: 2026-08-27

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

## 3. SCM Authentication Model

GitHub, Gitea, and GitLab are all shipped SCM providers as of `06-implementation-plan.md` §Phase
18 Stages 3–4; §3.1 documents GitHub's real, current implementation and §3.2 documents the
authentication and webhook-authenticity differences for Gitea/GitLab, since they are not uniform
across providers and directly affect this document's security guarantees. Every production
write-path caller — the opt-in `state doctor --check-scm` diagnostic, the scheduled reconciliation
task, the reviewer's diff fetch, merge-gate status-check publication, PR creation, the real merge
call, and (as of a third same-day Stage 6 follow-up) the coder adapter's own clone/push — resolves
`GITHUB_TOKEN`/`GITLAB_TOKEN`/`GITEA_TOKEN` per the repository's actual `provider` column, pairing
each with its own git-remote HTTPS Basic-Auth username: GitHub's `x-access-token`, GitLab's
`oauth2:<token>`, Gitea's `<token-in-password-field>` convention (username value is
documented-as-irrelevant, current placeholder `token`). **Gitea's convention and clone/push are
now live-verified, not just documented (a fourth same-day Stage 6 follow-up).** A real Gitea
1.22.3 instance (a directly-downloaded static binary, no Docker needed) confirmed the git-http
backend authenticates on the token in the password field regardless of the username sent, and that
a real clone/push round-trip — including every `GiteaScmClient` REST method — works correctly
end-to-end. **GitLab's convention remains a documented, high-confidence, but unverified one:** it
is GitLab's own long-documented, version-stable convention used identically against GitLab.com and
self-hosted CE/EE, but self-hosted GitLab CE has no equivalent lightweight, Docker-free
verification path the way Gitea's single binary does. See Stage 6's completion notes in
`06-implementation-plan.md` for the full writeup.

### 3.1 GitHub (current implementation)

- **GitHub App preferred over PAT.** Production deployments use a **GitHub App** with installation
  tokens (short-lived, least-privilege); a PAT is acceptable only for local/single-node development.
- **Least-privilege permissions:** contents (read/write), pull requests (read/write), checks
  (read/write), statuses (read/write), metadata (read), and webhooks — nothing broader.
- **Webhook signatures.** All inbound webhook deliveries are signature-verified (HMAC-SHA256 over
  the raw request body, `X-Hub-Signature-256`) before inbox persistence; unsigned/invalid
  deliveries are rejected and audited. See §5 for the current + previous secret rotation window.

### 3.2 Gitea and GitLab (shipped, docs/06 §Phase 18 Stages 3–4)

- **Gitea** uses the same authenticity model as GitHub: HMAC-SHA256 over the raw request body
  (`X-Gitea-Signature`), via its own dedicated verifier (`packages/gitea/src/webhook-signature.ts`)
  — same algorithm, same current+previous secret-rotation contract, different header name only.
- **GitLab has no HMAC signature scheme.** It authenticates a webhook delivery with a bare
  shared-secret token (`X-Gitlab-Token`) that GitLab echoes back unmodified — there is no signing
  of the request body, so payload tampering in transit is not detected the way it is for
  GitHub/Gitea; only knowledge of the configured secret is checked. This is a materially weaker
  authenticity model, not an equivalent one, and must be treated as such rather than silently
  assumed to be "the same, just a different header." Its verifier must be a **new**, distinct
  module doing a constant-time string comparison of the received token against the configured
  secret (never `===`/simple equality, which leaks timing information about how many leading
  bytes matched) — it is not a variant of `verifyWebhookSignature()`'s HMAC code path, and must not
  be implemented as one.
- **Auth-token model.** Each provider's `ScmClient` implementation resolves its own credential
  (GitHub App installation token or PAT; a GitLab personal/project/deploy access token; a Gitea
  access token) through the existing `SecretBackend` abstraction (§2) — no new secrets-management
  concept is introduced, only a new per-repository connection descriptor (provider, base URL, token
  reference, webhook-secret reference) recording which credential applies to which repository.

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
- **Server-side API credential, single shared identity (Phase 15 — Next.js Web UI).** `packages/web`
  reads the same `MINICODER_API_URL`/`MINICODER_API_KEY` env vars as the Text UI, but holds the key
  server-side only (`import 'server-only'`-guarded — see CLAUDE.md's "Next.js Web UI Operational
  Constraints") and never exposes it to the browser. This closes the "credential in the browser"
  risk, but does **not** provide per-end-user authentication or authorization: every browser
  session reaching a deployed `@minicoder/web` instance shares the one server-side key's role/
  actorKind identity — the Web UI process is a single logged-in "operator" (or whatever role the
  configured key carries) as far as the Orchestrator API is concerned, with no session/login layer
  of its own to distinguish one human viewer from another. This is the identical trust-boundary
  shape "Hosted mode" above already documents as future work (OAuth/SSO issuing short-lived,
  revocable, per-user sessions) — not a Phase 15-specific gap. **Until hosted-mode end-user
  auth ships, `packages/web` must only be deployed on a trusted/internal network (e.g. behind a VPN,
  an internal load balancer, or a reverse proxy that itself performs end-user authentication) — never
  exposed directly to the public internet with a privileged (`operator`/`approver`/`admin`) API key.**
  A `viewer`-role key is comparatively low-risk to expose more broadly (read-only), but still shares
  one identity across every viewer.

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
  `FilterDefaultDeny yes`) permitting GitHub hosts by default (the sandbox does git
  clone/commit/push), plus an optional `SCM_ALLOWED_HOST` env var (docs/06 §Phase 18 Stage 6's
  coder-adapter follow-up) for a self-hosted Gitea/GitLab deployment's own host; the
  container is always removed in a `finally` (success, failure, or cancellation); bounded-diff/
  disallowed-path enforcement runs as application logic (`diff-guard.ts`) on top of — not instead
  of — this container isolation; one branch per run, never force-pushed.
- **Deliberate trust-boundary split: the LLM code-generation call is host-side, not
  sandboxed.** `CodexCoderAdapter.run()` starts the sandbox for clone/list-files/write/commit/push,
  but calls `CodeGenerationProvider.generate()` (a plain `fetch`, `HttpCodeGenerationProvider`) in
  the Workflow Layer task-worker process itself — the _same_ process that holds `CODE_GEN_API_KEY` and
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
- **Data residency:** task payloads never leave the deployment's own database — the Workflow Layer
  execution backend is an in-repo, DB-backed task queue (`packages/triggerdev/`) with no managed/
  Cloud tier to reason about. **Superseded, kept for historical context:** this system previously
  ran on Trigger.dev, where choosing the Trigger.dev Cloud tier over a self-host backend was a real
  security/compliance decision (payloads left the deployment's boundary) — that tier no longer
  exists (see `00-glossary-and-terms.md` §6.2, `01-system-specification.md` §14).
- The "no secret in task payloads" rule is enforced as a Phase 2 architectural fitness test (see
  `06-implementation-plan.md` Phase 2). Implemented at:
  `packages/core/src/fitness/no-secret-in-task-payloads.test.ts` (RF-12). The test verifies that
  event payload Zod schemas contain no secret-bearing field names, and that `SecretRedactor` is
  applied via `defaultRedactor.redactObject()` before every outbox payload is serialized
  (`packages/core/src/commands/helpers.ts`).

## 6b. Trigger.dev Webhook-Secret Management (Phase 3) — superseded, removed

**Trigger.dev has been removed** (see `00-glossary-and-terms.md` §6, `01-system-specification.md`
§14, and CLAUDE.md's "Task Worker Operational Constraints" section). The Workflow Layer execution
backend is now an in-repo, DB-backed task queue (`packages/triggerdev/`) that the API/CLI processes
talk to directly over the shared database — there is no external Trigger.dev server, so
`TRIGGERDEV_API_KEY`/`TRIGGERDEV_WEBHOOK_SECRET`/`TRIGGER_ACCESS_TOKEN`/`TRIGGER_WEBHOOK_SECRET` no
longer exist as credentials anywhere in this codebase, and there is nothing to rotate. This section
is kept only for historical context on what these secrets used to protect; do not configure or
expect any of them in a current deployment.

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
