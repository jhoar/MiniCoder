import type {
  ProjectState,
  PlanState,
  FeatureExecutionState,
  AutomationState,
  AgentRunState,
  ArtifactExportState,
  ReadinessStatus,
  ClarificationStatus,
  FindingSeverity,
  AgentRole,
  FeatureKind,
  BudgetScope,
  EventStatus,
  CoderResponseType,
  DisagreementState,
  DesignDecisionStatus,
  GapSeverity,
} from './states.js';

// Shared base for all persisted entities
export interface Entity {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Project extends Entity {
  name: string;
  description: string | null;
  state: ProjectState;
}

export interface Repository extends Entity {
  projectId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface GithubLink extends Entity {
  projectId: string;
  repositoryId: string | null;
  installationId: string | null;
  appId: string | null;
  linkedAt: string;
}

export interface SpecificationInput extends Entity {
  projectId: string;
  content: string;
  contentType: string;
}

export interface PlanningReadinessAssessment extends Entity {
  projectId: string;
  specificationInputId: string | null;
  status: ReadinessStatus;
  summary: string | null;
}

export interface PlanningGap extends Entity {
  assessmentId: string;
  description: string;
  severity: GapSeverity;
  resolution: string | null;
  resolvedAt: string | null;
  clarificationSessionId: string | null;
}

export interface PlanningQuestion extends Entity {
  assessmentId: string;
  question: string;
  answer: string | null;
  answeredAt: string | null;
  round: number;
}

export interface PlanningAssumption extends Entity {
  assessmentId: string;
  description: string;
  confidence: 'high' | 'medium' | 'low';
  clarificationSessionId: string | null;
}

export interface ClarificationSession extends Entity {
  projectId: string;
  specificationInputId: string | null;
  status: ClarificationStatus;
  round: number;
  maxRounds: number;
  roundTimeoutAt: string | null;
}

export interface ClarificationQuestion extends Entity {
  clarificationSessionId: string;
  question: string;
  round: number;
  orderIndex: number;
  askedAt: string | null;
}

export interface ClarificationAnswer extends Entity {
  clarificationQuestionId: string;
  answer: string;
  actor: string;
  actorRole: string;
  answeredAt: string;
}

export interface ClarificationDecision extends Entity {
  clarificationSessionId: string;
  decisionType: string;
  actor: string;
  actorRole: string;
  notes: string | null;
  decidedAt: string;
}

export interface ImplementationPlan extends Entity {
  projectId: string;
  assessmentId: string | null;
  state: PlanState;
  title: string;
  summary: string | null;
}

export interface PlanSection extends Entity {
  planId: string;
  title: string;
  content: string;
  orderIndex: number;
}

export interface FeatureRequest extends Entity {
  planId: string;
  projectId: string;
  frId: string;
  title: string;
  description: string;
  kind: FeatureKind;
  executable: boolean;
  state: FeatureExecutionState;
  priority: number;
}

export interface FeatureDependency {
  id: string;
  sourceFrId: string;
  targetFrId: string;
  createdAt: string;
}

export interface AcceptanceCriteria extends Entity {
  featureRequestId: string;
  description: string;
  orderIndex: number;
}

export interface TestExpectation extends Entity {
  featureRequestId: string;
  description: string;
  testType: 'unit' | 'integration' | 'system' | null;
  orderIndex: number;
}

export interface WorkflowState extends Entity {
  projectId: string;
  activeFeatureRunId: string | null;
  automationState: AutomationState;
}

export interface FeatureRun extends Entity {
  featureRequestId: string;
  attemptNo: number;
  currentExecutionState: FeatureExecutionState;
  lockId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  outcome: 'succeeded' | 'failed' | 'cancelled' | null;
}

export interface WorkflowEvent {
  id: string;
  featureRunId: string | null;
  projectId: string;
  eventType: string;
  fromState: string | null;
  toState: string | null;
  actor: string | null;
  payload: string | null;
  payloadSchemaVersion: string;
  occurredAt: string;
  createdAt: string;
}

export interface WorkflowLock extends Entity {
  projectId: string;
  resourceKey: string;
  holderId: string;
  fence: number;
  acquiredAt: string;
  expiresAt: string | null;
}

export interface IdempotencyKey extends Entity {
  key: string;
  scope: string;
  result: string | null;
  expiresAt: string;
}

export interface OutboxEvent extends Entity {
  eventType: string;
  payload: string;
  payloadSchemaVersion: string;
  status: EventStatus;
  attempts: number;
  lastAttemptedAt: string | null;
  deliveredAt: string | null;
  error: string | null;
}

export interface InboxEvent extends Entity {
  dedupKey: string;
  source: string;
  eventType: string;
  payload: string;
  payloadSchemaVersion: string;
  status: EventStatus;
  attempts: number;
  lastAttemptedAt: string | null;
  processedAt: string | null;
  error: string | null;
}

export interface HumanApproval extends Entity {
  projectId: string;
  featureRequestId: string | null;
  featureRunId: string | null;
  contextType: string;
  contextId: string | null;
  decision: 'approved' | 'rejected' | 'deferred' | null;
  actor: string;
  actorRole: string;
  notes: string | null;
  decidedAt: string | null;
}

export interface PolicyDecision extends Entity {
  projectId: string;
  featureRunId: string | null;
  policyType: string;
  decision: string;
  context: string | null;
  actor: string | null;
  decidedAt: string;
}

export interface AgentAdapter extends Entity {
  role: AgentRole;
  name: string;
  implementation: string;
  isActive: boolean;
}

export interface AgentCapability extends Entity {
  adapterId: string;
  capability: string;
  parameters: string | null;
}

export interface AgentConfiguration extends Entity {
  adapterId: string;
  projectId: string | null;
  config: string;
}

export interface AgentRun extends Entity {
  adapterId: string;
  projectId: string | null;
  featureRunId: string | null;
  role: AgentRole;
  state: AgentRunState;
  inputSummary: string | null;
  outputSummary: string | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  tokensUsed: number | null;
  costUsd: number | null;
  /**
   * Immutable adapter provenance snapshot (migration 0004), null for rows written before the
   * migration. Populated automatically by AgentRunRecorder from the registry at invocation time.
   */
  adapterName: string | null;
  adapterImplementation: string | null;
  adapterVersion: number | null;
  /** JSON-encoded array of capability tokens exercised during the run. */
  capabilitiesUsed: string | null;
}

export interface AgentError {
  id: string;
  agentRunId: string;
  errorType: string;
  message: string;
  stack: string | null;
  occurredAt: string;
  createdAt: string;
}

export interface AgentToolOperation {
  id: string;
  agentRunId: string;
  toolName: string;
  inputSummary: string | null;
  outputSummary: string | null;
  status: 'success' | 'error';
  durationMs: number | null;
  occurredAt: string;
  createdAt: string;
}

export interface AgentContextPack extends Entity {
  agentRunId: string;
  content: string;
  contentSchemaVersion: string;
}

export interface AdapterConformanceResult {
  id: string;
  adapterId: string | null;
  role: AgentRole;
  testSuite: string;
  passed: boolean;
  totalTests: number;
  failedTests: number;
  /** Scenarios intentionally not applicable to this adapter (migration 0005). */
  skippedTests: number;
  details: string | null;
  runAt: string;
  createdAt: string;
}

export interface ReviewFinding extends Entity {
  featureRunId: string;
  reviewerRunId: string | null;
  reviewCycle: number;
  severity: FindingSeverity;
  category: string | null;
  description: string;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  resolved: boolean;
  resolvedByRunId: string | null;
}

export interface CoderResponse extends Entity {
  findingId: string;
  coderRunId: string;
  responseType: CoderResponseType;
  notes: string | null;
}

export interface DisagreementRecord extends Entity {
  featureRunId: string;
  findingId: string | null;
  reviewCycle: number;
  state: DisagreementState;
  arbiterRunId: string | null;
  resolution: string | null;
  resolvedAt: string | null;
}

export interface BudgetPolicy extends Entity {
  projectId: string;
  scope: BudgetScope;
  featureRequestId: string | null;
  currency: string;
  softLimit: number | null;
  hardLimit: number | null;
  windowDays: number | null;
  isActive: boolean;
}

export interface CostRecord extends Entity {
  projectId: string;
  featureRequestId: string | null;
  featureRunId: string | null;
  agentRunId: string | null;
  scope: BudgetScope;
  amount: number;
  currency: string;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  recordedAt: string;
  expiresAt: string | null;
}

export interface ArtifactExport extends Entity {
  projectId: string;
  artifactType: 'plan' | 'backlog' | 'final-design-document';
  state: ArtifactExportState;
  content: string | null;
  format: string;
  exportedAt: string | null;
  error: string | null;
}

export interface DesignDocument extends Entity {
  projectId: string;
  state: string;
}

export interface DesignDocumentSection extends Entity {
  designDocumentId: string;
  sectionName: string;
  content: string | null;
  orderIndex: number;
}

export interface DesignDecision extends Entity {
  projectId: string;
  designDocumentId: string | null;
  title: string;
  context: string | null;
  decision: string;
  consequences: string | null;
  status: DesignDecisionStatus;
}

export interface GlossaryTerm extends Entity {
  projectId: string | null;
  term: string;
  definition: string;
  category: string | null;
}

export interface TriggerdevRun extends Entity {
  triggerdevRunId: string;
  triggerdevTaskId: string;
  triggerdevStatus: string;
  projectId: string | null;
  linkedWorkflowEventId: string | null;
  linkedAgentRunId: string | null;
  linkedFeatureRunId: string | null;
  lastSeenAt: string;
}

export interface MergeGateEvaluation extends Entity {
  featureRunId: string;
  ciStatus: string | null;
  reviewStatus: string | null;
  unresolvedBlockingFindings: number;
  budgetStatus: string | null;
  humanApprovalRequired: boolean;
  humanApprovalId: string | null;
  branchProtectionOk: boolean;
  finalDecision: 'approved' | 'rejected';
  evaluatedAt: string;
}
