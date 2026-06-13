-- Down migration: 0001_initial_schema
-- Dialect: PostgreSQL
-- Drops all 43 tables in reverse dependency order (children before parents).
-- CASCADE is included as a safety net for any FK references not covered by ordering.

DROP TABLE IF EXISTS "merge_gate_evaluations" CASCADE;
DROP TABLE IF EXISTS "triggerdev_runs" CASCADE;
DROP TABLE IF EXISTS "glossary_terms" CASCADE;
DROP TABLE IF EXISTS "design_decisions" CASCADE;
DROP TABLE IF EXISTS "design_document_sections" CASCADE;
DROP TABLE IF EXISTS "design_documents" CASCADE;
DROP TABLE IF EXISTS "artifact_exports" CASCADE;
DROP TABLE IF EXISTS "cost_records" CASCADE;
DROP TABLE IF EXISTS "budget_policies" CASCADE;
DROP TABLE IF EXISTS "disagreement_records" CASCADE;
DROP TABLE IF EXISTS "coder_responses" CASCADE;
DROP TABLE IF EXISTS "review_findings" CASCADE;
DROP TABLE IF EXISTS "adapter_conformance_results" CASCADE;
DROP TABLE IF EXISTS "agent_context_packs" CASCADE;
DROP TABLE IF EXISTS "agent_tool_operations" CASCADE;
DROP TABLE IF EXISTS "agent_errors" CASCADE;
DROP TABLE IF EXISTS "agent_runs" CASCADE;
DROP TABLE IF EXISTS "agent_configurations" CASCADE;
DROP TABLE IF EXISTS "agent_capabilities" CASCADE;
DROP TABLE IF EXISTS "agent_adapters" CASCADE;
DROP TABLE IF EXISTS "policy_decisions" CASCADE;
DROP TABLE IF EXISTS "human_approvals" CASCADE;
DROP TABLE IF EXISTS "inbox_events" CASCADE;
DROP TABLE IF EXISTS "outbox_events" CASCADE;
DROP TABLE IF EXISTS "idempotency_keys" CASCADE;
DROP TABLE IF EXISTS "workflow_locks" CASCADE;
DROP TABLE IF EXISTS "workflow_events" CASCADE;
DROP TABLE IF EXISTS "feature_runs" CASCADE;
DROP TABLE IF EXISTS "workflow_states" CASCADE;
DROP TABLE IF EXISTS "test_expectations" CASCADE;
DROP TABLE IF EXISTS "acceptance_criteria" CASCADE;
DROP TABLE IF EXISTS "feature_dependencies" CASCADE;
DROP TABLE IF EXISTS "feature_requests" CASCADE;
DROP TABLE IF EXISTS "plan_sections" CASCADE;
DROP TABLE IF EXISTS "implementation_plans" CASCADE;
DROP TABLE IF EXISTS "planning_assumptions" CASCADE;
DROP TABLE IF EXISTS "planning_questions" CASCADE;
DROP TABLE IF EXISTS "planning_gaps" CASCADE;
DROP TABLE IF EXISTS "planning_readiness_assessments" CASCADE;
DROP TABLE IF EXISTS "specification_inputs" CASCADE;
DROP TABLE IF EXISTS "github_links" CASCADE;
DROP TABLE IF EXISTS "repositories" CASCADE;
DROP TABLE IF EXISTS "projects" CASCADE;
