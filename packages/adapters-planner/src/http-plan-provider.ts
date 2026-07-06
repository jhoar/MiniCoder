import type {
  PlanProvider,
  ReadinessAssessmentRequest,
  ReadinessAssessmentResult,
  PlanSectionRequest,
  PlanSectionResult,
  FeatureBacklogRequest,
  FeatureBacklogResult,
  GeneratedFeatureRaw,
} from './plan-provider.js';

export interface HttpPlanProviderOptions {
  /** Base URL of an OpenAI-compatible chat/completions endpoint. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
}

interface ChatCompletionBody {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Plain fetch-based client against an OpenAI-compatible chat/completions endpoint — mirrors
 * `@minicoder/adapters-reviewer`'s `HttpReviewProvider` exactly, adapted for the three planner
 * calls (readiness assessment, plan-section generation, feature-backlog generation). No vendor
 * SDK dependency, consistent with core's provider-SDK-free posture even though that rule
 * technically only binds `packages/core`.
 */
export class HttpPlanProvider implements PlanProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpPlanProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async complete(
    systemPrompt: string,
    userPayload: unknown,
  ): Promise<{
    content: unknown;
    tokensUsed?: { input: number; output: number };
    requestBody: unknown;
  }> {
    const requestBody = {
      model: this.options.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
    };
    const response = await this.fetchImpl(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`plan request failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as ChatCompletionBody;
    const rawContent = body.choices?.[0]?.message?.content;
    if (!rawContent) {
      throw new Error('plan response contained no message content');
    }

    let content: unknown;
    try {
      content = JSON.parse(rawContent);
    } catch {
      throw new Error('plan response was not valid JSON');
    }

    return {
      content,
      tokensUsed: body.usage
        ? { input: body.usage.prompt_tokens ?? 0, output: body.usage.completion_tokens ?? 0 }
        : undefined,
      requestBody,
    };
  }

  async assessReadiness(request: ReadinessAssessmentRequest): Promise<ReadinessAssessmentResult> {
    const { content, tokensUsed, requestBody } = await this.complete(
      'You are a planning readiness assessor. Respond with a JSON object ' +
        '{"readinessResult": "sufficient"|"sufficient_with_assumptions"|"insufficient", ' +
        '"questions": [{"question": string, "round": number}], ' +
        '"assumptions": [{"description": string, "confidence": "high"|"medium"|"low"}], ' +
        '"gaps": [{"description": string, "severity": "blocking"|"non_blocking"}]} ' +
        'assessing whether the given specification is ready for implementation planning. ' +
        'No prose, JSON only.',
      { specificationContent: request.specificationContent },
    );

    const parsed = content as Partial<ReadinessAssessmentResult>;
    if (
      parsed.readinessResult !== 'sufficient' &&
      parsed.readinessResult !== 'sufficient_with_assumptions' &&
      parsed.readinessResult !== 'insufficient'
    ) {
      throw new Error('readiness response contained an invalid readinessResult');
    }

    return {
      readinessResult: parsed.readinessResult,
      questions: parsed.questions ?? [],
      assumptions: parsed.assumptions ?? [],
      gaps: parsed.gaps ?? [],
      tokensUsed,
      promptSnapshot: requestBody,
    };
  }

  async generatePlanSections(request: PlanSectionRequest): Promise<PlanSectionResult> {
    const { content, tokensUsed, requestBody } = await this.complete(
      'You are an implementation planner. Respond with a JSON object ' +
        '{"title": string, "summary"?: string, "sections": [{"title": string, "content": string}]} ' +
        'decomposing the given specification into implementation plan sections. ' +
        'No prose, JSON only.',
      { specificationContent: request.specificationContent },
    );

    const parsed = content as Partial<PlanSectionResult>;
    if (typeof parsed.title !== 'string' || !Array.isArray(parsed.sections)) {
      throw new Error('plan-section response was missing title/sections');
    }

    return {
      title: parsed.title,
      summary: parsed.summary,
      sections: parsed.sections,
      tokensUsed,
      promptSnapshot: requestBody,
    };
  }

  async generateFeatureBacklog(request: FeatureBacklogRequest): Promise<FeatureBacklogResult> {
    const { content, tokensUsed, requestBody } = await this.complete(
      'You are a feature backlog generator. Respond with a JSON object ' +
        '{"features": [{"frId": string, "title": string, "description": string, ' +
        '"kind": "feature"|"discovery", "priority": number, "dependsOnFrIds": string[], ' +
        '"acceptanceCriteria": string[], "testExpectations": [{"description": string, ' +
        '"testType": "unit"|"integration"|"system"|null}]}]} decomposing the given implementation ' +
        'plan sections into a dependency-ordered feature backlog. No prose, JSON only.',
      { planSections: request.planSections },
    );

    const parsed = content as { features?: GeneratedFeatureRaw[] };
    if (!Array.isArray(parsed.features)) {
      throw new Error('feature-backlog response was missing features');
    }

    return {
      features: parsed.features,
      tokensUsed,
      promptSnapshot: requestBody,
    };
  }
}
