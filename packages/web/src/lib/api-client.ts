/**
 * HTTP client for the Orchestrator API (packages/api) — the non-guarded core, split out of
 * `api-server.ts` (which adds the `server-only` import guard) so unit tests can construct
 * `ApiClient` directly with a fake `fetchImpl`, exactly like `packages/tui/src/client/api-client.ts`'s
 * own tests do. Importing `server-only` outside a Next.js server-component bundle throws
 * unconditionally, so the class itself must live in a module that doesn't import it. Structurally
 * mirrors `packages/tui/src/client/api-client.ts` (same constructor shape, same private
 * `request<T>()`, same `ApiError`/RFC 9457 problem-detail handling, same injectable-`fetchImpl`
 * seam). See CLAUDE.md's "Next.js Web UI Operational Constraints" section for the reasoning.
 */
import type {
  CursorPage,
  ProjectRow,
  RepositoryRow,
  GithubLinkRow,
  SpecificationInputRow,
  PlanningReadinessRow,
  ClarificationSessionRow,
  ClarificationQuestionRow,
  ImplementationPlanRow,
  FeatureRequestRow,
  FeatureRunRow,
  PullRequestRow,
  HumanRequiredItemRow,
  AgentRunRow,
  AgentAdapterRow,
  AgentConfigurationRow,
  ReviewFindingRow,
  DisagreementRow,
  PolicyDecisionRow,
  CostRecordRow,
  BudgetPolicyRow,
  ArtifactExportRow,
  DesignDocumentRow,
  DesignDocumentSectionRow,
  WorkflowEventRow,
  MergeGateEvaluationRow,
  TriggerdevRunRow,
  DoctorResult,
  ValidationResult,
  ReconcileResult,
  DiagnosticsExport,
} from '@minicoder/api';

export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
}

/** Thrown for any non-2xx Orchestrator API response, carrying the parsed RFC 9457 problem body. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly problem: ProblemDetail,
  ) {
    super(problem.detail || problem.title);
    this.name = 'ApiError';
  }
}

export interface WhoamiResponse {
  id: string;
  role: string;
  actorKind: 'human' | 'system';
  displayName?: string;
}

export interface ProjectStatus {
  project: { id: string; name: string; state: string } | null;
  workflowState: {
    automation_state: string;
    active_feature_run_id: string | null;
    version: number;
  } | null;
  pendingOutboxCount: number;
}

export interface CommandEnvelopeResponse {
  command_id: string;
  accepted: boolean;
  resulting_state: string;
  emitted_event_ids: string[];
}

export interface TriggeredRunResponse {
  triggerdevRunId: string;
  accepted: boolean;
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class ApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: ApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: {
      query?: Record<string, string | undefined>;
      body?: unknown;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const url = new URL(path, this.options.baseUrl);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
    };
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
      cache: 'no-store',
    });

    const rawBody: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const problem: ProblemDetail =
        rawBody && typeof rawBody === 'object' && 'type' in rawBody
          ? (rawBody as ProblemDetail)
          : {
              type: 'unknown-error',
              title: 'Unknown error',
              status: response.status,
              detail: `HTTP ${response.status}`,
            };
      throw new ApiError(response.status, problem);
    }
    return rawBody as T;
  }

  private get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  private post<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    return this.request<T>('POST', path, { body, idempotencyKey });
  }

  // ---- Reads ----

  getWhoami(): Promise<WhoamiResponse> {
    return this.get<WhoamiResponse>('/whoami');
  }

  getStatus(projectId: string): Promise<ProjectStatus> {
    return this.get<ProjectStatus>('/status', { projectId });
  }

  listProjects(query?: { cursor?: string; limit?: string }): Promise<CursorPage<ProjectRow>> {
    return this.get('/projects', query);
  }

  getProject(id: string): Promise<ProjectRow> {
    return this.get(`/projects/${encodeURIComponent(id)}`);
  }

  listRepositories(
    projectId?: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<RepositoryRow>> {
    return this.get('/repositories', { projectId, ...query });
  }

  listGithubLinks(
    projectId?: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<GithubLinkRow>> {
    return this.get('/github-links', { projectId, ...query });
  }

  listSpecificationInputs(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<SpecificationInputRow>> {
    return this.get('/specification-inputs', { projectId, ...query });
  }

  listImplementationPlans(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<ImplementationPlanRow>> {
    return this.get('/plans', { projectId, ...query });
  }

  getImplementationPlan(id: string): Promise<ImplementationPlanRow> {
    return this.get(`/plans/${encodeURIComponent(id)}`);
  }

  listPlanningReadinessAssessments(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<PlanningReadinessRow>> {
    return this.get('/planning-readiness-assessments', { projectId, ...query });
  }

  getPlanningReadinessAssessment(id: string): Promise<PlanningReadinessRow> {
    return this.get(`/planning-readiness-assessments/${encodeURIComponent(id)}`);
  }

  listClarificationSessions(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<ClarificationSessionRow>> {
    return this.get('/clarification-sessions', { projectId, ...query });
  }

  getClarificationSession(
    id: string,
  ): Promise<{ session: ClarificationSessionRow; questions: ClarificationQuestionRow[] }> {
    return this.get(`/clarification-sessions/${encodeURIComponent(id)}`);
  }

  listFeatures(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<FeatureRequestRow>> {
    return this.get('/features', { projectId, ...query });
  }

  getFeature(id: string): Promise<{ feature: FeatureRequestRow; runs: FeatureRunRow[] }> {
    return this.get(`/features/${encodeURIComponent(id)}`);
  }

  getFeatureRun(id: string): Promise<FeatureRunRow> {
    return this.get(`/feature-runs/${encodeURIComponent(id)}`);
  }

  getActiveFeature(
    projectId: string,
  ): Promise<{ automationState: string; activeFeatureRun: FeatureRunRow | null }> {
    return this.get('/active-feature', { projectId });
  }

  listPullRequests(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<PullRequestRow>> {
    return this.get('/pull-requests', { projectId, ...query });
  }

  /** No `/pull-requests?number=` filter exists on the API today (decision #7 of the Phase 15
   * plan) — this fetches pages until a match is found or the list is exhausted. Acceptable given
   * this repo's expected per-project PR volume; revisit with a real API filter if that changes. */
  async findPullRequestByNumber(
    projectId: string,
    prNumber: number,
  ): Promise<PullRequestRow | null> {
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await this.listPullRequests(projectId, { cursor, limit: '100' });
      const match = page.items.find((pr) => pr.pr_number === prNumber);
      if (match) return match;
      if (!page.nextCursor) return null;
      cursor = page.nextCursor;
    }
    return null;
  }

  getPullRequestByFeatureRun(featureRunId: string): Promise<PullRequestRow> {
    return this.get(`/feature-runs/${encodeURIComponent(featureRunId)}/pull-request`);
  }

  listHumanRequiredItems(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<HumanRequiredItemRow>> {
    return this.get('/human-required-items', { projectId, ...query });
  }

  listAgentRuns(
    filters: { projectId?: string; featureRunId?: string },
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<AgentRunRow>> {
    return this.get('/agent-runs', { ...filters, ...query });
  }

  getAgentRun(id: string): Promise<AgentRunRow> {
    return this.get(`/agent-runs/${encodeURIComponent(id)}`);
  }

  listAgentAdapters(query?: {
    cursor?: string;
    limit?: string;
  }): Promise<CursorPage<AgentAdapterRow>> {
    return this.get('/agent-adapters', query);
  }

  listAgentConfigurations(
    adapterId?: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<AgentConfigurationRow>> {
    return this.get('/agent-configurations', { adapterId, ...query });
  }

  listReviewFindings(
    featureRunId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<ReviewFindingRow>> {
    return this.get('/review-findings', { featureRunId, ...query });
  }

  listDisagreements(
    filters: { featureRunId?: string; state?: string },
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<DisagreementRow>> {
    return this.get('/disagreements', { ...filters, ...query });
  }

  listPolicyDecisions(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<PolicyDecisionRow>> {
    return this.get('/policy-decisions', { projectId, ...query });
  }

  listCostRecords(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<CostRecordRow>> {
    return this.get('/costs', { projectId, ...query });
  }

  listBudgetPolicies(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<BudgetPolicyRow>> {
    return this.get('/budgets', { projectId, ...query });
  }

  listArtifactExports(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<ArtifactExportRow>> {
    return this.get('/artifacts', { projectId, ...query });
  }

  getArtifactExport(id: string): Promise<ArtifactExportRow> {
    return this.get(`/artifacts/${encodeURIComponent(id)}`);
  }

  listDesignDocuments(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<DesignDocumentRow>> {
    return this.get('/design-documents', { projectId, ...query });
  }

  getDesignDocument(
    id: string,
  ): Promise<{ document: DesignDocumentRow; sections: DesignDocumentSectionRow[] }> {
    return this.get(`/design-documents/${encodeURIComponent(id)}`);
  }

  listWorkflowEvents(
    filters: { projectId?: string; featureRunId?: string },
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<WorkflowEventRow>> {
    return this.get('/workflow-events', { ...filters, ...query });
  }

  listMergeGateEvaluations(
    featureRunId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<MergeGateEvaluationRow>> {
    return this.get('/merge-gate-evaluations', { featureRunId, ...query });
  }

  listTriggerdevRuns(
    filters: { projectId?: string; featureRunId?: string },
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<TriggerdevRunRow>> {
    return this.get('/triggerdev-runs', { ...filters, ...query });
  }

  // ---- Diagnostics (POST-as-read; operator role required by the backend) ----

  getValidateStatus(projectId?: string): Promise<ValidationResult> {
    return this.post('/commands/validate', { projectId });
  }

  getDoctorStatus(projectId?: string): Promise<DoctorResult> {
    return this.post('/commands/doctor', { projectId });
  }

  exportDiagnostics(projectId?: string): Promise<DiagnosticsExport> {
    return this.post('/commands/export-diagnostics', { projectId });
  }

  // ---- Generic-dispatch commands (all require a caller-supplied Idempotency-Key) ----

  submitPlanForApproval(
    payload: { planId: string; projectId: string; expectedVersion: number },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/submit-plan-for-approval', payload, idempotencyKey);
  }

  approvePlan(
    payload: { planId: string; projectId: string; expectedVersion: number; notes?: string },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/approve-plan', payload, idempotencyKey);
  }

  activatePlan(
    payload: { planId: string; projectId: string; expectedVersion: number },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/activate-plan', payload, idempotencyKey);
  }

  exportPlan(
    payload: { planId: string; projectId: string },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/export-plan', payload, idempotencyKey);
  }

  exportBacklog(
    payload: { planId: string; projectId: string },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/export-backlog', payload, idempotencyKey);
  }

  startClarification(
    payload: { clarificationSessionId: string; projectId: string; expectedVersion: number },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/start-clarification', payload, idempotencyKey);
  }

  recordClarificationAnswer(
    payload: {
      clarificationQuestionId: string;
      clarificationSessionId: string;
      projectId: string;
      answer: string;
      expectedQuestionVersion: number;
    },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/record-clarification-answer', payload, idempotencyKey);
  }

  completeClarification(
    payload: { clarificationSessionId: string; projectId: string; expectedVersion: number },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/complete-clarification', payload, idempotencyKey);
  }

  selectFeature(
    payload: { featureRunId: string; projectId: string; expectedVersion: number },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/select-feature', payload, idempotencyKey);
  }

  resolveDisagreement(
    payload: {
      featureRunId: string;
      projectId: string;
      expectedVersion: number;
      resolution: string;
      disagreementId?: string;
    },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/resolve-disagreement', payload, idempotencyKey);
  }

  resumeFeatureExecution(
    payload: {
      featureRunId: string;
      projectId: string;
      expectedVersion: number;
      notes: string;
      disagreementId?: string;
    },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/resume-feature-execution', payload, idempotencyKey);
  }

  retryFeature(
    payload: { featureRunId: string; projectId: string; expectedVersion: number; notes: string },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/retry-feature', payload, idempotencyKey);
  }

  skipFeature(
    payload: { featureRunId: string; projectId: string; expectedVersion: number; notes: string },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/skip-feature', payload, idempotencyKey);
  }

  blockFeature(
    payload: { featureRunId: string; projectId: string; expectedVersion: number; notes: string },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/block-feature', payload, idempotencyKey);
  }

  approveBudgetOverride(
    payload: {
      projectId: string;
      expectedVersion: number;
      overrideReason: string;
      approvedBudgetPolicyId: string;
    },
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/approve-budget-override', payload, idempotencyKey);
  }

  pauseAutomation(
    projectId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/pause-automation', { projectId, expectedVersion }, idempotencyKey);
  }

  resumeAutomation(
    projectId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/resume-automation', { projectId, expectedVersion }, idempotencyKey);
  }

  // ---- Dedicated routes ----

  mergeIfReady(
    payload: {
      featureRunId: string;
      projectId: string;
      mergeMethod?: 'merge' | 'squash' | 'rebase';
    },
    idempotencyKey: string,
  ): Promise<{ merged: boolean; [key: string]: unknown }> {
    return this.post('/commands/merge-if-ready', payload, idempotencyKey);
  }

  finalizeIfGithubMerged(payload: {
    featureRunId: string;
    projectId: string;
  }): Promise<{ alreadyRecorded: boolean; merged?: boolean; [key: string]: unknown }> {
    return this.post('/commands/finalize-if-github-merged', payload);
  }

  requestCoderRun(
    payload: { projectId: string; featureRunId: string; coderAdapterName: string },
    idempotencyKey: string,
  ): Promise<TriggeredRunResponse> {
    return this.post('/commands/request-coder-run', payload, idempotencyKey);
  }

  requestReview(
    payload: {
      projectId: string;
      featureRunId: string;
      reviewerAdapterName: string;
      arbiterAdapterName?: string;
    },
    idempotencyKey: string,
  ): Promise<TriggeredRunResponse> {
    return this.post('/commands/request-review', payload, idempotencyKey);
  }

  requestFixes(
    payload: { projectId: string; featureRunId: string; reviewerAdapterName: string },
    idempotencyKey: string,
  ): Promise<TriggeredRunResponse> {
    return this.post('/commands/request-fixes', payload, idempotencyKey);
  }

  recomputeMergeGate(
    payload: { projectId: string; featureRunId: string },
    idempotencyKey: string,
  ): Promise<TriggeredRunResponse> {
    return this.post('/commands/recompute-merge-gate', payload, idempotencyKey);
  }

  reconcile(
    payload: { projectId?: string; all?: boolean },
    idempotencyKey: string,
  ): Promise<ReconcileResult> {
    return this.post('/commands/reconcile', payload, idempotencyKey);
  }
}
