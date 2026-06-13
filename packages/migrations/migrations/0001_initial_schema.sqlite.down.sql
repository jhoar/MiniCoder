-- Down migration: 0001_initial_schema
-- Dialect: SQLite
-- Drops all 43 tables in reverse dependency order (children before parents).

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS "merge_gate_evaluations";
DROP TABLE IF EXISTS "triggerdev_runs";
DROP TABLE IF EXISTS "glossary_terms";
DROP TABLE IF EXISTS "design_decisions";
DROP TABLE IF EXISTS "design_document_sections";
DROP TABLE IF EXISTS "design_documents";
DROP TABLE IF EXISTS "artifact_exports";
DROP TABLE IF EXISTS "cost_records";
DROP TABLE IF EXISTS "budget_policies";
DROP TABLE IF EXISTS "disagreement_records";
DROP TABLE IF EXISTS "coder_responses";
DROP TABLE IF EXISTS "review_findings";
DROP TABLE IF EXISTS "adapter_conformance_results";
DROP TABLE IF EXISTS "agent_context_packs";
DROP TABLE IF EXISTS "agent_tool_operations";
DROP TABLE IF EXISTS "agent_errors";
DROP TABLE IF EXISTS "agent_runs";
DROP TABLE IF EXISTS "agent_configurations";
DROP TABLE IF EXISTS "agent_capabilities";
DROP TABLE IF EXISTS "agent_adapters";
DROP TABLE IF EXISTS "policy_decisions";
DROP TABLE IF EXISTS "human_approvals";
DROP TABLE IF EXISTS "inbox_events";
DROP TABLE IF EXISTS "outbox_events";
DROP TABLE IF EXISTS "idempotency_keys";
DROP TABLE IF EXISTS "workflow_locks";
DROP TABLE IF EXISTS "workflow_events";
DROP TABLE IF EXISTS "feature_runs";
DROP TABLE IF EXISTS "workflow_states";
DROP TABLE IF EXISTS "test_expectations";
DROP TABLE IF EXISTS "acceptance_criteria";
DROP TABLE IF EXISTS "feature_dependencies";
DROP TABLE IF EXISTS "feature_requests";
DROP TABLE IF EXISTS "plan_sections";
DROP TABLE IF EXISTS "implementation_plans";
DROP TABLE IF EXISTS "planning_assumptions";
DROP TABLE IF EXISTS "planning_questions";
DROP TABLE IF EXISTS "planning_gaps";
DROP TABLE IF EXISTS "planning_readiness_assessments";
DROP TABLE IF EXISTS "specification_inputs";
DROP TABLE IF EXISTS "github_links";
DROP TABLE IF EXISTS "repositories";
DROP TABLE IF EXISTS "projects";

PRAGMA foreign_keys = ON;
