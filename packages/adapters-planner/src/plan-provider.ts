/**
 * Small, injected LLM-planning seam (issue #32), mirroring `@minicoder/adapters-reviewer`'s
 * `ReviewProvider` seam exactly: ship exactly one concrete implementation
 * (`HttpPlanProvider`, a plain-fetch OpenAI-compatible client); tests use a deterministic fake of
 * this interface instead of a real API. No sandbox is involved — planning is a read/generate-only
 * LLM call, the same posture `ReviewProvider` already established for reviewing.
 */
export interface ReadinessAssessmentRequest {
  readonly specificationContent: string;
  readonly correlationId: string;
}

export interface ReadinessAssessmentResult {
  readonly readinessResult: 'sufficient' | 'sufficient_with_assumptions' | 'insufficient';
  readonly questions: ReadonlyArray<{ readonly question: string; readonly round: number }>;
  readonly assumptions: ReadonlyArray<{
    readonly description: string;
    readonly confidence: 'high' | 'medium' | 'low';
  }>;
  readonly gaps: ReadonlyArray<{
    readonly description: string;
    readonly severity: 'blocking' | 'non_blocking';
  }>;
  readonly tokensUsed?: { readonly input: number; readonly output: number };
  readonly promptSnapshot?: unknown;
}

export interface PlanSectionRequest {
  readonly specificationContent: string;
  readonly correlationId: string;
}

export interface PlanSectionResult {
  readonly title: string;
  readonly summary?: string;
  readonly sections: ReadonlyArray<{ readonly title: string; readonly content: string }>;
  readonly tokensUsed?: { readonly input: number; readonly output: number };
  readonly promptSnapshot?: unknown;
}

export interface FeatureBacklogRequest {
  readonly planSections: ReadonlyArray<{ readonly title: string; readonly content: string }>;
  readonly correlationId: string;
}

export interface GeneratedFeatureRaw {
  readonly frId: string;
  readonly title: string;
  readonly description: string;
  readonly kind: 'feature' | 'discovery';
  readonly priority: number;
  readonly dependsOnFrIds: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly testExpectations: ReadonlyArray<{
    readonly description: string;
    readonly testType: 'unit' | 'integration' | 'system' | null;
  }>;
}

export interface FeatureBacklogResult {
  readonly features: readonly GeneratedFeatureRaw[];
  readonly tokensUsed?: { readonly input: number; readonly output: number };
  readonly promptSnapshot?: unknown;
}

export interface PlanProvider {
  assessReadiness(request: ReadinessAssessmentRequest): Promise<ReadinessAssessmentResult>;
  generatePlanSections(request: PlanSectionRequest): Promise<PlanSectionResult>;
  generateFeatureBacklog(request: FeatureBacklogRequest): Promise<FeatureBacklogResult>;
}
