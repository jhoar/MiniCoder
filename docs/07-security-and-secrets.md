# MiniCoder — Security and Secrets Specification

> Status: Canonical
> Supersedes: (new — extracts and expands `01-system-specification.md` §15)
> Version: 1.0.2
> Last-updated: 2026-06-13

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

- **Secret backend abstraction.** Secrets are resolved through a backend interface:
  `EnvSecretBackend` (environment variables) for local/single-node; `ManagedSecretBackend`
  (cloud KMS/secret manager) for hosted/team. Code never hard-codes secrets. A plaintext
  `FileSecretBackend` was considered and rejected: reading unencrypted JSON from disk violates
  the "encrypted at rest" invariant below. Local developers use OS keychain, a secrets manager
  CLI exporting env vars, or Docker/CI secrets injection — never a committed plaintext file.
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

MiniCoder uses `TRIGGERDEV_WEBHOOK_SECRET` to verify that inbound payloads from the self-hosted
Trigger.dev server have not been tampered with. This secret must be:

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
