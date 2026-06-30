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

export type CoderBehavior = 'success' | 'fail' | 'invalid_output';

export interface CoderInput {
  projectId: string;
  featureRunId: string;
  featureTitle: string;
  acceptanceCriteria: string[];
  correlationId: string;
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
}

export interface ReviewFindingOutput {
  severity: 'blocking' | 'non_blocking' | 'nit' | 'question';
  category: string;
  description: string;
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
