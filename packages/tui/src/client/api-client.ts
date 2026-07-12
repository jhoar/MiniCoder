/**
 * HTTP client for the Orchestrator API (packages/api) — the only way this package talks to
 * MiniCoder. Mirrors the injectable-`fetchImpl` seam already established by
 * `packages/adapters-planner/src/http-plan-provider.ts` (and the reviewer/arbiter siblings) so
 * unit tests can inject a fake `fetch` instead of hitting the network.
 */
import type {
  CursorPage,
  PlanningReadinessRow,
  ClarificationSessionRow,
  ClarificationQuestionRow,
  ImplementationPlanRow,
  FeatureRequestRow,
  FeatureRunRow,
  PullRequestRow,
  AgentRunRow,
  AgentAdapterRow,
  AgentConfigurationRow,
  ReviewFindingRow,
  DisagreementRow,
  CostRecordRow,
  BudgetPolicyRow,
  ArtifactExportRow,
  DesignDocumentRow,
  DesignDocumentSectionRow,
  HumanRequiredItemRow,
  TriggerdevRunRow,
  DoctorResult,
  BudgetReport,
  FeatureRunTimeline,
} from '@minicoder/api';
import type { ProjectAcceptanceResult } from '@minicoder/core';

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  /** Request timeout in milliseconds — defaults to 10s (mirrors `HttpPlanProvider`'s pattern,
   * scaled down since this talks to our own API, not an LLM provider). */
  readonly timeoutMs?: number;
}

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
  project: { id: string; name: string; state: string; version: number } | null;
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

  getWhoami(): Promise<WhoamiResponse> {
    return this.get<WhoamiResponse>('/whoami');
  }

  getStatus(projectId: string): Promise<ProjectStatus> {
    return this.get<ProjectStatus>('/status', { projectId });
  }

  listImplementationPlans(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<ImplementationPlanRow>> {
    return this.get('/plans', { projectId, ...query });
  }

  listPlanningReadinessAssessments(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<PlanningReadinessRow>> {
    return this.get('/planning-readiness-assessments', { projectId, ...query });
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

  listHumanRequiredItems(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<HumanRequiredItemRow>> {
    return this.get('/human-required-items', { projectId, ...query });
  }

  getActiveFeature(
    projectId: string,
  ): Promise<{ automationState: string; activeFeatureRun: FeatureRunRow | null }> {
    return this.get('/active-feature', { projectId });
  }

  getPullRequestByFeatureRun(featureRunId: string): Promise<PullRequestRow> {
    return this.get(`/feature-runs/${encodeURIComponent(featureRunId)}/pull-request`);
  }

  listAgentRuns(
    filters: { projectId?: string; featureRunId?: string },
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<AgentRunRow>> {
    return this.get('/agent-runs', { ...filters, ...query });
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

  /** Phase 16: aggregate spend breakdown by scope/feature/provider/model/role. */
  getBudgetReport(projectId: string, windowDays?: number): Promise<BudgetReport> {
    return this.get('/budget-report', {
      projectId,
      windowDays: windowDays !== undefined ? String(windowDays) : undefined,
    });
  }

  /** Phase 16: the merged chronological history for one feature run. */
  getFeatureRunTimeline(featureRunId: string): Promise<FeatureRunTimeline> {
    return this.get(`/feature-runs/${encodeURIComponent(featureRunId)}/timeline`, {});
  }

  listArtifactExports(
    projectId: string,
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<ArtifactExportRow>> {
    return this.get('/artifacts', { projectId, ...query });
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

  listTriggerdevRuns(
    filters: { projectId?: string; featureRunId?: string },
    query?: { cursor?: string; limit?: string },
  ): Promise<CursorPage<TriggerdevRunRow>> {
    return this.get('/triggerdev-runs', { ...filters, ...query });
  }

  /** `POST /commands/doctor` — operator-role-gated state-health check (docs/05 §8). Callers
   * (e.g. the `status` view) should catch a 403 `ApiError` and simply omit this section for a
   * lower-privileged key rather than failing the whole command — the API enforces authorization,
   * the TUI never duplicates the role check itself. */
  getDoctorStatus(projectId?: string): Promise<DoctorResult> {
    return this.post('/commands/doctor', { projectId });
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

  /** `GET /project-acceptance` (Phase 17) — Project Acceptance Validation's DB-knowable checks. */
  getProjectAcceptance(projectId: string): Promise<ProjectAcceptanceResult> {
    return this.get('/project-acceptance', { projectId });
  }

  // Phase 17: project-lifecycle / final design document commands.

  markImplementationComplete(
    projectId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post(
      '/commands/mark-implementation-complete',
      { projectId, expectedVersion },
      idempotencyKey,
    );
  }

  generateDesignDocument(
    projectId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post(
      '/commands/generate-design-document',
      { projectId, expectedVersion },
      idempotencyKey,
    );
  }

  regenerateDesignDocument(
    projectId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post(
      '/commands/regenerate-design-document',
      { projectId, expectedVersion },
      idempotencyKey,
    );
  }

  requestDesignDocumentRevision(
    projectId: string,
    expectedVersion: number,
    designDocumentId: string,
    notes: string | undefined,
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post(
      '/commands/request-design-document-revision',
      { projectId, expectedVersion, designDocumentId, notes },
      idempotencyKey,
    );
  }

  approveDesignDocument(
    projectId: string,
    expectedVersion: number,
    designDocumentId: string,
    notes: string | undefined,
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post(
      '/commands/approve-design-document',
      { projectId, expectedVersion, designDocumentId, notes },
      idempotencyKey,
    );
  }

  completeProject(
    projectId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<CommandEnvelopeResponse> {
    return this.post('/commands/complete-project', { projectId, expectedVersion }, idempotencyKey);
  }

  /** Enqueues the `run-design-doc` Trigger.dev task (drafts sections, exports
   * final-design-document.md, records the document ready). */
  requestDesignDoc(
    projectId: string,
    documentationAdapterName: string,
    idempotencyKey: string,
  ): Promise<{ triggerdevRunId: string; accepted: boolean }> {
    return this.post(
      '/commands/request-design-doc',
      { projectId, documentationAdapterName },
      idempotencyKey,
    );
  }
}
