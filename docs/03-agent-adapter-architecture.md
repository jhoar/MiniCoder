# MiniCoder — Agent Adapter Architecture Specification

> Status: Canonical
> Supersedes: minicoder_agent_adapter_architecture_specification.md,
> minicoder_agent_adapter_architecture_specification_testing_updated.md
> Version: 1.0.0
> Last-updated: 2026-06-12

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

## 4. Trigger.dev Invocation

Agent adapter invocations may run inside Trigger.dev tasks. Trigger.dev owns durable execution,
retries, queues, schedules, and waitpoints. Adapters own provider invocation and output
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

## 9. Reference and Mock Adapters

- **Roles (interfaces):** the six in §2.
- **Deterministic mocks:** `MockPlannerAdapter`, `MockCoderAdapter`, `MockReviewerAdapter`,
  `MockArbiterAdapter`, `MockDocumentationAdapter`, and `HumanTestAdapter` (the test mock of
  `HumanAgentAdapter`).
- **Reference (provider) adapters:** `GenericLLMPlannerAdapter`, `CodexCoderAdapter`,
  `ClaudeReviewerAdapter`, `GenericLLMDocumentationAdapter` — reference implementations only, never
  architectural dependencies.

## 10. Acceptance

- Core does not depend on provider SDKs.
- Mock adapters run through Trigger.dev task wrappers and in `system_test` mode.
- AgentRun records are created and capabilities are validated before invocation.
- Adapters normalize outputs and redact secrets.
