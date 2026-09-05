export type PlannerBehavior = 'sufficient' | 'sufficient_with_assumptions' | 'insufficient';

export interface PlannerInput {
  projectId: string;
  specificationContent: string;
  correlationId: string;
}

export interface PlannerOutput {
  readinessResult: 'sufficient' | 'sufficient_with_assumptions' | 'insufficient';
  questions: Array<{ question: string; round: number }>;
  assumptions: Array<{ description: string; confidence: 'high' | 'medium' | 'low' }>;
  gaps: Array<{ description: string; severity: 'blocking' | 'non_blocking' }>;
}

/**
 * Issue #32: plan-section-generation call shape. `GenerateImplementationPlanHandler`'s own doc
 * comment previously noted this shape didn't exist ("plan section content is caller-supplied
 * here rather than invented ad hoc") — this closes that gap, matching docs/03 §5's
 * PlannerAgentAdapter responsibility list ("plan generation") that predates this contract.
 */
export interface PlanSectionGenerationInput {
  projectId: string;
  assessmentId: string;
  specificationContent: string;
  correlationId: string;
}

export interface PlanSectionGenerationOutput {
  title: string;
  summary?: string;
  sections: Array<{ title: string; content: string }>;
  /** Token usage reported by the underlying provider, if any — additive (issue #100's sibling
   * gap for `run()`/readiness-assessment remains separately tracked). Lets a caller wrap this
   * call in `AgentRunRecorder.record()` with a real `costExtractor`, the same way `run-coder.ts`
   * does for the Coder role, instead of silently reporting zero planning-phase generation cost. */
  tokensUsed?: { input: number; output: number };
}

/**
 * Issue #32: feature-backlog-generation call shape, matching
 * `GenerateFeatureBacklogPayload.features`'s structure exactly (`FeatureInputSchema` in
 * `packages/core/src/commands/handlers/planning/generate-feature-backlog.ts`) so a caller can
 * pass this output straight through without reshaping it.
 */
export interface FeatureBacklogGenerationInput {
  projectId: string;
  planId: string;
  planSections: Array<{ title: string; content: string }>;
  correlationId: string;
}

export interface GeneratedFeature {
  frId: string;
  title: string;
  description: string;
  kind: 'feature' | 'discovery';
  priority: number;
  dependsOnFrIds: string[];
  acceptanceCriteria: string[];
  testExpectations: Array<{
    description: string;
    testType: 'unit' | 'integration' | 'system' | null;
  }>;
}

export interface FeatureBacklogGenerationOutput {
  features: GeneratedFeature[];
  /** Token usage reported by the underlying provider, if any — same additive rationale as
   * `PlanSectionGenerationOutput.tokensUsed` above. */
  tokensUsed?: { input: number; output: number };
}

export type CoderBehavior = 'success' | 'fail' | 'invalid_output';

export interface CoderInput {
  projectId: string;
  featureRunId: string;
  featureTitle: string;
  acceptanceCriteria: string[];
  correlationId: string;
  /** Unresolved review_findings for this feature run (Phase 10 fix-cycle re-entry), if any —
   * only populated when run-coder.ts invokes the adapter against a run in `fixing` rather than
   * `coding`. Absent/empty for a first-pass `coding` invocation. */
  openFindings?: Array<{ id: string; description: string }>;
}

export interface CoderOutput {
  commitSha: string;
  branchName: string;
  filesChanged: number;
}

export type ReviewerBehavior = 'approve' | 'request_changes' | 'repeat_finding';

export interface ReviewerInput {
  projectId: string;
  featureRunId: string;
  prNumber: number;
  reviewCycle: number;
  correlationId: string;
  /** Additive (issue #47), mirroring CoderInput's shape — the real feature title/acceptance
   * criteria the PR is supposed to satisfy, so the reviewer can check the diff against them
   * instead of a synthesized placeholder. Optional so existing MockReviewerAdapter-based tests
   * that don't set them keep compiling; run-review.ts's real call site always populates both. */
  featureTitle?: string;
  acceptanceCriteria?: string[];
}

export interface ReviewFindingOutput {
  // Widened (Phase 10) to the full FindingSeverity domain (docs/00 §3.7) — 'out_of_scope' and
  // 'requires_human_decision' were missing from the adapter contract even though the domain enum
  // (packages/core/src/domain/states.ts's FindingSeverity) always had all 6 values.
  severity:
    | 'blocking'
    | 'non_blocking'
    | 'nit'
    | 'question'
    | 'out_of_scope'
    | 'requires_human_decision';
  category: string;
  description: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface ReviewerOutput {
  decision: 'approved' | 'changes_requested';
  findings: ReviewFindingOutput[];
}

export type ArbiterBehavior = 'resolve' | 'escalate';

export interface ArbiterInput {
  projectId: string;
  featureRunId: string;
  findingDescription: string;
  coderPosition: string;
  reviewerPosition: string;
  correlationId: string;
}

export interface ArbiterOutput {
  resolution: 'coder_correct' | 'reviewer_correct' | 'compromise' | 'escalate_to_human';
  notes: string;
}

export type DocumentationBehavior = 'succeed' | 'require_revision';

export interface DocumentationInput {
  projectId: string;
  planId: string;
  featureCount: number;
  correlationId: string;
}

export interface DocumentationOutput {
  documentId: string;
  sections: Array<{ sectionName: string; content: string }>;
  requiresRevision: boolean;
}

export type HumanDecision = 'approved' | 'rejected' | 'deferred';

export interface HumanApprovalInput {
  projectId: string;
  contextType: string;
  contextId: string;
  description: string;
  correlationId: string;
}

export interface HumanApprovalOutput {
  decision: HumanDecision;
  notes: string;
}

export interface AdapterCall<I, O> {
  input: I;
  output: O;
  calledAt: string;
}

export interface PlannerAgentAdapter {
  readonly role: 'PlannerAgentAdapter';
  run(input: PlannerInput): Promise<PlannerOutput>;
  /** Optional (additive): not every PlannerAgentAdapter implementation generates plan content —
   * only an adapter that declares these can be used by `generate-implementation-plan`/
   * `generate-feature-backlog`'s adapter-invocation path (issue #32's `GenericLLMPlannerAdapter`
   * is the one shipped implementation that does). */
  generatePlanSections?(input: PlanSectionGenerationInput): Promise<PlanSectionGenerationOutput>;
  generateFeatureBacklog?(
    input: FeatureBacklogGenerationInput,
  ): Promise<FeatureBacklogGenerationOutput>;
}

export interface CoderAgentAdapter {
  readonly role: 'CoderAgentAdapter';
  run(input: CoderInput): Promise<CoderOutput>;
}

export interface ReviewerAgentAdapter {
  readonly role: 'ReviewerAgentAdapter';
  run(input: ReviewerInput): Promise<ReviewerOutput>;
}

export interface ArbiterAgentAdapter {
  readonly role: 'ArbiterAgentAdapter';
  run(input: ArbiterInput): Promise<ArbiterOutput>;
}

export interface DocumentationAgentAdapter {
  readonly role: 'DocumentationAgentAdapter';
  run(input: DocumentationInput): Promise<DocumentationOutput>;
}

export interface HumanAgentAdapter {
  readonly role: 'HumanAgentAdapter';
  run(input: HumanApprovalInput): Promise<HumanApprovalOutput>;
}
