import type {
  PlannerAgentAdapter,
  PlannerInput,
  PlannerOutput,
  PlanSectionGenerationInput,
  PlanSectionGenerationOutput,
  FeatureBacklogGenerationInput,
  FeatureBacklogGenerationOutput,
} from '@minicoder/core';
import type { PlanProvider } from './plan-provider.js';

export interface GenericLLMPlannerAdapterOptions {
  readonly planProvider: PlanProvider;
}

/**
 * Reference `PlannerAgentAdapter` implementation (issue #32; docs/02 §7 named this
 * `GenericLLMPlannerAdapter` as future work). Mirrors `@minicoder/adapters-reviewer`'s
 * `ClaudeReviewerAdapter` shape: no sandbox (a planning call is read/generate-only, same posture
 * reviewing already established), a single injected `PlanProvider` seam, called directly from the
 * Trigger.dev task process rather than from inside any sandboxed execution.
 *
 * Implements all three `PlannerAgentAdapter` methods: `run()` (readiness assessment, the
 * Phase 5-vintage contract `planning-readiness-assessment` already calls) and the two issue-#32
 * additions, `generatePlanSections()`/`generateFeatureBacklog()`, which
 * `generate-implementation-plan`/`generate-feature-backlog` can invoke instead of requiring a
 * caller to have already assembled plan/feature content by hand.
 */
export class GenericLLMPlannerAdapter implements PlannerAgentAdapter {
  readonly role = 'PlannerAgentAdapter' as const;

  constructor(private readonly options: GenericLLMPlannerAdapterOptions) {}

  async run(input: PlannerInput): Promise<PlannerOutput> {
    const result = await this.options.planProvider.assessReadiness({
      specificationContent: input.specificationContent,
      correlationId: input.correlationId,
    });

    return {
      readinessResult: result.readinessResult,
      questions: result.questions.map((q) => ({ question: q.question, round: q.round })),
      assumptions: result.assumptions.map((a) => ({
        description: a.description,
        confidence: a.confidence,
      })),
      gaps: result.gaps.map((g) => ({ description: g.description, severity: g.severity })),
    };
  }

  async generatePlanSections(
    input: PlanSectionGenerationInput,
  ): Promise<PlanSectionGenerationOutput> {
    const result = await this.options.planProvider.generatePlanSections({
      specificationContent: input.specificationContent,
      correlationId: input.correlationId,
    });

    return {
      title: result.title,
      summary: result.summary,
      sections: result.sections.map((s) => ({ title: s.title, content: s.content })),
      tokensUsed: result.tokensUsed,
    };
  }

  async generateFeatureBacklog(
    input: FeatureBacklogGenerationInput,
  ): Promise<FeatureBacklogGenerationOutput> {
    const result = await this.options.planProvider.generateFeatureBacklog({
      planSections: input.planSections,
      correlationId: input.correlationId,
    });

    return {
      features: result.features.map((f) => ({
        frId: f.frId,
        title: f.title,
        description: f.description,
        kind: f.kind,
        priority: f.priority,
        dependsOnFrIds: [...f.dependsOnFrIds],
        acceptanceCriteria: [...f.acceptanceCriteria],
        testExpectations: f.testExpectations.map((t) => ({
          description: t.description,
          testType: t.testType,
        })),
      })),
      tokensUsed: result.tokensUsed,
    };
  }
}
