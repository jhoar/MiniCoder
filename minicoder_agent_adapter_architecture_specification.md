# MiniCoder — Agent Adapter Architecture Specification

## 1. Purpose

MiniCoder integrates agents through role-based adapters. The system must not depend on any specific provider or product. Codex, Claude, Copilot, Cursor, Aider, OpenHands, and future tools are adapter implementations only.

## 2. Adapter Roles

MiniCoder defines these adapter roles:

- PlannerAgentAdapter
- CoderAgentAdapter
- ReviewerAgentAdapter
- ArbiterAgentAdapter
- DocumentationAgentAdapter
- HumanAgentAdapter

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

Agent adapter invocations may run inside Trigger.dev tasks. Trigger.dev owns durable execution, retries, queues, schedules, and waitpoints. Adapters own provider invocation and output normalization. Orchestrator Core owns state transitions and policy.

Task definitions must not embed provider-specific behavior directly.

## 5. PlannerAgentAdapter

Responsible for readiness assessment, clarification question generation, plan generation, feature generation, and revision.

## 6. CoderAgentAdapter

Responsible for implementing approved features, working on assigned branches, modifying files, running tests where possible, committing and pushing changes, and addressing review findings. It must not merge PRs independently.

## 7. ReviewerAgentAdapter

Responsible for reviewing PRs, returning structured findings, classifying blocking/non-blocking issues, and providing evidence and required action.

## 8. ArbiterAgentAdapter

Responsible for resolving structured disagreements, classifying out-of-scope findings, and recommending human escalation.

## 9. DocumentationAgentAdapter

Responsible for drafting the final System Design Document from structured MiniCoder records and repository evidence. It does not decide project completion.

## 10. HumanAgentAdapter

Responsible for manual approvals and fallback decisions. Human actions must be auditable.

## 11. AgentRun Records

Every adapter invocation creates an AgentRun record with agent_run_id, project_id, feature_request_id, role, adapter_name, provider, model, capabilities_used, triggerdev_run_id, prompt_template_version, input_artifact_references, output_artifact_references, status, started_at, completed_at, latency_ms, token_usage, estimated_cost, actual_cost, error_code, and error_summary.

Private chain-of-thought must not be stored.

## 12. Adapter Configuration

Adapter configuration is database-backed. Simple deployments may import defaults from configuration files, but the resolved active configuration is stored and visible through the Orchestrator API.

## 13. Conformance Testing

Every adapter must pass conformance tests for configuration validation, capability declaration, successful run, timeout/failure, invalid output, secret redaction, cost/token reporting where available, and structured output normalization.

## 14. Reference Adapters

Initial reference adapters may include MockPlannerAdapter, MockCoderAdapter, MockReviewerAdapter, MockArbiterAdapter, HumanAgentAdapter, GenericLLMPlannerAdapter, CodexCoderAdapter, ClaudeReviewerAdapter, and GenericLLMDocumentationAdapter. These are reference implementations only.
