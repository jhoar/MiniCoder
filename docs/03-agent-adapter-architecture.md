# MiniCoder — Agent Adapter Architecture Specification

> Status: Canonical
> Supersedes: minicoder_agent_adapter_architecture_specification.md,
> minicoder_agent_adapter_architecture_specification_testing_updated.md
> Version: 1.0.1
> Last-updated: 2026-07-04

Role and adapter names are defined in [`00-glossary-and-terms.md`](00-glossary-and-terms.md) §4.

## 1. Purpose

MiniCoder integrates agents through role-based adapters. The system must not depend on any specific
provider or product. Codex, Claude, Copilot, Cursor, Aider, OpenHands, and future tools are adapter
implementations only.

## 2. Adapter Roles

- `PlannerAgentAdapter`
- `CoderAgentAdapter`
- `ReviewerAgentAdapter`
- `ArbiterAgentAdapter`
- `DocumentationAgentAdapter`
- `HumanAgentAdapter`

## 3. Capability Model

Adapters declare capabilities such as:

```text
can_generate_plan
can_generate_clarification_questions
can_modify_files
can_run_tests
can_commit
can_push_branch
can_open_pull_request
can_review_pull_request
can_return_structured_findings
can_resolve_disagreement
can_generate_design_document
can_report_token_usage
can_report_cost
can_run_asynchronously
can_report_run_status
```

The orchestrator validates capabilities before invocation.

## 4. Workflow Layer Invocation

Agent adapter invocations may run inside Workflow Layer tasks. The Workflow Layer owns durable
execution, retries, queues, schedules, and waitpoints. Adapters own provider invocation and output
normalization. Orchestrator Core owns state transitions and policy. Task retries must be idempotent,
and task definitions must not embed provider-specific behavior directly.

## 5. Role Responsibilities

- **PlannerAgentAdapter** — readiness assessment, clarification-question generation, plan
  generation, feature generation, and revision.
- **CoderAgentAdapter** — implements approved features on assigned branches, modifies files, runs
  tests where possible, commits and pushes changes, and addresses review findings. It must not
  merge PRs independently.
- **ReviewerAgentAdapter** — reviews PRs, returns structured findings, classifies
  blocking/non-blocking issues, and provides evidence and required action.
- **ArbiterAgentAdapter** — resolves structured disagreements, classifies out-of-scope findings,
  and recommends human escalation.
- **DocumentationAgentAdapter** — drafts the final System Design Document from structured MiniCoder
  records and repository evidence. It does not decide project completion.
- **HumanAgentAdapter** — manual approvals and fallback decisions. Human actions must be auditable.

## 6. AgentRun Records

Every adapter invocation creates an `agent_runs` record with `agent_run_id`, `project_id`,
`feature_request_id`, `role`, `adapter_name`, `provider`, `model`, `capabilities_used`,
`triggerdev_run_id`, `prompt_template_version`, `input_artifact_references`,
`output_artifact_references`, `status`, `started_at`, `completed_at`, `latency_ms`, `token_usage`,
`estimated_cost`, `actual_cost`, `error_code`, and `error_summary`.

**Phase 9 implementation note.** `provider`/`model`/`prompt_template_version` are real columns on
`agent_runs` as of migration `0010_agent_run_provider_tracking.*`, populated automatically by
`AgentRunRecorder`'s `costExtractor` extension. `input_artifact_references`/
`output_artifact_references` are **not** separate columns — input maps onto the new
`agent_context_packs` row id (`AgentRunRecorder`'s `contextPack` option), and output stays in the
existing `output_summary` JSON; a dedicated join column was considered and rejected as redundant
(see docs/06 Phase 9 "Delivered modules"). `agent_run_id` in this list is the real `feature_run_id`
column, not a separate `feature_request_id`-scoped identifier — the schema has always used
`feature_run_id` (see docs/06 Phase 5's note on this same naming divergence). `triggerdev_run_id` is
**not** a direct column — the existing `triggerdev_runs.linked_agent_run_id` join already covers
it, and adding a second, redundant join column was explicitly rejected.

Stored observability includes context-pack references, prompt-template versions, visible outputs
where policy allows, tool calls, diffs or references, test excerpts, structured findings, decision
summaries, evidence references, and cost/token records. **Private chain-of-thought must not be
stored.**

## 7. Adapter Configuration

Adapter configuration is database-backed. Simple deployments may import defaults from configuration
files, but the resolved active configuration is stored and visible through the Orchestrator API.

## 8. Conformance Testing

Every adapter must pass conformance tests for configuration validation, capability declaration,
successful run, timeout/failure, invalid output, secret redaction, cost/token reporting where
available, and structured-output normalization. Results are stored in `adapter_conformance_results`.
Adapters must support deterministic test scenarios.

**Phase 5 implements smoke-level conformance only.** The Phase 5 suite
(`phase5-smoke-conformance`, 9 scenarios × 6 adapters) verifies adapter wiring against the mock
implementations: capability declaration, successful run, failure handling, invalid-output handling
(skipped for roles that have no deterministic invalid-output mock), secret redaction, configuration
resolution, state-transition sequencing, output shape, and assertCapabilities. The full canonical
adapter-contract gate — timeout taxonomy, cost/token reporting, structured-output normalization,
and Workflow Layer wrapper invocation — is deferred to Phase 9+ when real provider adapters are
connected. See [`docs/06-implementation-plan.md`](06-implementation-plan.md) §Phase 5 for the
detailed scope.

## 9. Reference and Mock Adapters

- **Roles (interfaces):** the six in §2.
- **Deterministic mocks:** `MockPlannerAdapter`, `MockCoderAdapter`, `MockReviewerAdapter`,
  `MockArbiterAdapter`, `MockDocumentationAdapter`, and `HumanTestAdapter` (the test mock of
  `HumanAgentAdapter`).
- **Reference (provider) adapters:** `GenericLLMPlannerAdapter`, `CodexCoderAdapter`,
  `ClaudeReviewerAdapter`, `GenericLLMDocumentationAdapter` — reference implementations only, never
  architectural dependencies. **`CodexCoderAdapter` is delivered as of Phase 9**
  (`packages/adapters-coder`), implementing `CoderAgentAdapter` against an ephemeral, sandboxed
  workspace and an injected `CodeGenerationProvider` seam (see §11 and
  [`06-implementation-plan.md`](06-implementation-plan.md) Phase 9). The other three reference
  adapters remain future work.

## 10. Acceptance

These are the architecture's full end-state acceptance criteria, delivered incrementally across
phases (see [`06-implementation-plan.md`](06-implementation-plan.md) for what each phase actually
completes — Phase 5 delivers direct adapter invocation via the conformance runner and
`AgentRunRecorder`; Workflow Layer task-wrapper invocation is not part of Phase 5's completed
scope):

- Core does not depend on provider SDKs.
- Mock adapters run through Workflow Layer task wrappers and in `system_test` mode.
- AgentRun records are created and capabilities are validated before invocation.
- Adapters normalize outputs and redact secrets.

## 11. Adapter Execution Contract

Roles and capabilities (above) describe _what_ an adapter does; this contract makes adapter runs
_implementable and safe_. It applies to all execution-capable adapters (Coder, Reviewer, and any
file/tool-using adapter) and is enforced by the orchestrator and conformance tests.

### 11.1 Workspace and isolation

- Each run executes in an **isolated, ephemeral workspace** — a fresh checkout at a known directory,
  on the feature's own branch (`minicoder/<feature-request-id>`), torn down after the run.
- One run owns one branch; no run may touch another feature's branch. Force-push is disallowed.
- Workspaces are sandboxed with a default-deny **network egress** policy and **least-privilege
  secret exposure** (only the credentials the run needs); see
  [`07-security-and-secrets.md`](07-security-and-secrets.md).

### 11.2 Tool and command permissions

- Adapters declare the tools/commands they use; the orchestrator validates them against an allowed
  set before invocation. Test execution is permitted within the sandbox; arbitrary host commands are
  not.

### 11.3 File-change and commit contract

- Output is expressed as a **bounded diff**: changes are limited to the workspace, must stay under a
  configurable **maximum diff size**, and are rejected if they touch disallowed paths.
- Commits are attributed to the run, reference the feature request ID, and never include secrets.
  The adapter commits and pushes but **never merges**.

### 11.4 Structured I/O schemas

- Inputs (context pack) and outputs (e.g., review findings, change summaries) use **versioned Zod
  schemas**; non-conforming output is a normalized failure, not a crash.

### 11.5 Status, streaming, and cancellation

- Adapters report run status (`queued`/`running`/`succeeded`/`failed`) and may stream progress.
- Runs are **cancellable**; on cancellation the workspace is cleaned up and the run recorded as
  cancelled.

### 11.6 Retries, idempotency, and errors

- Runs are driven by idempotent Workflow Layer tasks carrying an **idempotency key**; a retried run
  must not double-commit or double-push.
- Adapters map provider failures to a **normalized error taxonomy** (e.g.,
  `timeout`, `rate_limited`, `invalid_output`, `auth`, `provider_unavailable`, `cancelled`), which
  the orchestrator uses for retry/escalation decisions.
