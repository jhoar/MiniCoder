/**
 * Canonical state literals from docs/00-glossary-and-terms.md.
 * These must match the glossary exactly — do not rename or add variants.
 */

// §3.1 Planning states
export const PlanState = {
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  ACTIVATED_FOR_EXECUTION: 'activated_for_execution',
} as const;
export type PlanState = (typeof PlanState)[keyof typeof PlanState];

// §3.1 Project lifecycle states
export const ProjectState = {
  ACTIVE: 'active',
  IMPLEMENTATION_COMPLETE: 'implementation_complete',
  DESIGN_DOCUMENT_GENERATING: 'design_document_generating',
  DESIGN_DOCUMENT_READY_FOR_REVIEW: 'design_document_ready_for_review',
  DESIGN_DOCUMENT_REVISION_REQUESTED: 'design_document_revision_requested',
  DESIGN_DOCUMENT_APPROVED: 'design_document_approved',
  PROJECT_COMPLETE: 'project_complete',
} as const;
export type ProjectState = (typeof ProjectState)[keyof typeof ProjectState];

// §3.2 Feature execution states
export const FeatureExecutionState = {
  APPROVED_PENDING_EXECUTION: 'approved_pending_execution',
  SELECTED: 'selected',
  CODING: 'coding',
  CODE_PUSHED: 'code_pushed',
  PR_OPENED: 'pr_opened',
  CI_RUNNING: 'ci_running',
  UNDER_REVIEW: 'under_review',
  CHANGES_REQUESTED: 'changes_requested',
  FIXING: 'fixing',
  APPROVED_BY_POLICY: 'approved_by_policy',
  MERGE_READY: 'merge_ready',
  MERGED: 'merged',
  CI_FAILED: 'ci_failed',
  MERGE_FAILED: 'merge_failed',
  HUMAN_REQUIRED: 'human_required',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  SYSTEM_FAILED: 'system_failed',
  // Phase 11: terminal disposition a human chooses via `SkipFeatureCommand` from
  // `human_required` — the feature will not be automated further. Not in glossary §3.2/§3.3's
  // original state lists; added here per glossary editing rule ("do not introduce a new state
  // without adding it to 00-glossary-and-terms.md first" — see docs/00 §3.2 update).
  SKIPPED: 'skipped',
} as const;
export type FeatureExecutionState =
  (typeof FeatureExecutionState)[keyof typeof FeatureExecutionState];

// §3.8 Automation control states
export const AutomationState = {
  RUNNING: 'running',
  PAUSED_BY_OPERATOR: 'paused_by_operator',
  PAUSED_BUDGET_EXCEEDED: 'paused_budget_exceeded',
  WAITING_FOR_BUDGET_APPROVAL: 'waiting_for_budget_approval',
} as const;
export type AutomationState = (typeof AutomationState)[keyof typeof AutomationState];

// Agent run states
export const AgentRunState = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type AgentRunState = (typeof AgentRunState)[keyof typeof AgentRunState];

// Workflow run states
export const WorkflowRunState = {
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING: 'waiting',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type WorkflowRunState = (typeof WorkflowRunState)[keyof typeof WorkflowRunState];

// PR/review states (mirrors GitHub)
export const PrReviewState = {
  NONE: 'none',
  PENDING: 'pending',
  COMMENTED: 'commented',
  CHANGES_REQUESTED: 'changes_requested',
  APPROVED: 'approved',
  DISMISSED: 'dismissed',
} as const;
export type PrReviewState = (typeof PrReviewState)[keyof typeof PrReviewState];

// Artifact export states
export const ArtifactExportState = {
  PENDING: 'pending',
  GENERATING: 'generating',
  EXPORTED: 'exported',
  STALE: 'stale',
  FAILED: 'failed',
} as const;
export type ArtifactExportState = (typeof ArtifactExportState)[keyof typeof ArtifactExportState];

// Planning readiness states
export const ReadinessStatus = {
  SUFFICIENT: 'sufficient',
  SUFFICIENT_WITH_ASSUMPTIONS: 'sufficient_with_assumptions',
  INSUFFICIENT: 'insufficient',
} as const;
export type ReadinessStatus = (typeof ReadinessStatus)[keyof typeof ReadinessStatus];

// §3.6 Clarification statuses
export const ClarificationStatus = {
  NOT_REQUIRED: 'clarification_not_required',
  REQUIRED: 'clarification_required',
  IN_PROGRESS: 'clarification_in_progress',
  COMPLETE: 'clarification_complete',
  BLOCKED: 'clarification_blocked',
} as const;
export type ClarificationStatus = (typeof ClarificationStatus)[keyof typeof ClarificationStatus];

// §3.7 Review finding severities
export const FindingSeverity = {
  BLOCKING: 'blocking',
  NON_BLOCKING: 'non_blocking',
  QUESTION: 'question',
  NIT: 'nit',
  OUT_OF_SCOPE: 'out_of_scope',
  REQUIRES_HUMAN_DECISION: 'requires_human_decision',
} as const;
export type FindingSeverity = (typeof FindingSeverity)[keyof typeof FindingSeverity];

// §4.1 Agent adapter roles
export const AgentRole = {
  PLANNER: 'PlannerAgentAdapter',
  CODER: 'CoderAgentAdapter',
  REVIEWER: 'ReviewerAgentAdapter',
  ARBITER: 'ArbiterAgentAdapter',
  DOCUMENTATION: 'DocumentationAgentAdapter',
  HUMAN: 'HumanAgentAdapter',
} as const;
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

// §4.4 User/auth roles
export const UserRole = {
  VIEWER: 'viewer',
  OPERATOR: 'operator',
  APPROVER: 'approver',
  ADMIN: 'admin',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

// Feature request kinds
export const FeatureKind = {
  FEATURE: 'feature',
  DISCOVERY: 'discovery',
} as const;
export type FeatureKind = (typeof FeatureKind)[keyof typeof FeatureKind];

// Budget policy scopes
export const BudgetScope = {
  PROJECT: 'project',
  FEATURE: 'feature',
  REVIEW_CYCLE: 'review_cycle',
} as const;
export type BudgetScope = (typeof BudgetScope)[keyof typeof BudgetScope];

// Outbox/inbox event statuses
export const EventStatus = {
  PENDING: 'pending',
  DELIVERED: 'delivered',
  PROCESSED: 'processed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const;
export type EventStatus = (typeof EventStatus)[keyof typeof EventStatus];

// Coder response types
export const CoderResponseType = {
  FIXED: 'fixed',
  DEFERRED: 'deferred',
  DISPUTED: 'disputed',
  ACKNOWLEDGED: 'acknowledged',
} as const;
export type CoderResponseType = (typeof CoderResponseType)[keyof typeof CoderResponseType];

// Disagreement record states
export const DisagreementState = {
  OPEN: 'open',
  RESOLVED: 'resolved',
  ESCALATED: 'escalated',
} as const;
export type DisagreementState = (typeof DisagreementState)[keyof typeof DisagreementState];

// Design decision statuses
export const DesignDecisionStatus = {
  PROPOSED: 'proposed',
  ACCEPTED: 'accepted',
  DEPRECATED: 'deprecated',
  SUPERSEDED: 'superseded',
} as const;
export type DesignDecisionStatus = (typeof DesignDecisionStatus)[keyof typeof DesignDecisionStatus];

// Gap severities
export const GapSeverity = {
  BLOCKING: 'blocking',
  NON_BLOCKING: 'non_blocking',
} as const;
export type GapSeverity = (typeof GapSeverity)[keyof typeof GapSeverity];

// Workflow task IDs — exact canonical token strings from docs/02-bootstrap-planner-clarification.md §6
export const WorkflowTaskId = {
  INGEST_SPECIFICATION: 'ingest-specification',
  PLANNING_READINESS_ASSESSMENT: 'planning-readiness-assessment',
  START_CLARIFICATION: 'start-clarification',
  RECORD_CLARIFICATION_ANSWER: 'record-clarification-answer',
  COMPLETE_CLARIFICATION: 'complete-clarification',
  GENERATE_IMPLEMENTATION_PLAN: 'generate-implementation-plan',
  GENERATE_FEATURE_BACKLOG: 'generate-feature-backlog',
  VALIDATE_BACKLOG: 'validate-backlog',
  REQUEST_PLAN_APPROVAL: 'request-plan-approval',
  ACTIVATE_APPROVED_BACKLOG: 'activate-approved-backlog',
  START_NEXT_FEATURE: 'start-next-feature',
  GITHUB_RECONCILIATION: 'github-reconciliation',
  EXPORT_PLAN: 'export-plan',
  EXPORT_BACKLOG: 'export-backlog',
  IMPORT_BACKLOG: 'import-backlog',
} as const;
export type WorkflowTaskId = (typeof WorkflowTaskId)[keyof typeof WorkflowTaskId];
