import { z } from 'zod';
import type {
  PlanProvider,
  ReadinessAssessmentRequest,
  ReadinessAssessmentResult,
  PlanSectionRequest,
  PlanSectionResult,
  FeatureBacklogRequest,
  FeatureBacklogResult,
} from './plan-provider.js';

export interface HttpPlanProviderOptions {
  /** Base URL of an OpenAI-compatible chat/completions endpoint. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
  /** Request timeout in milliseconds — defaults to 30s. An LLM endpoint is an untrusted external
   * dependency; without this, a hung request would rely entirely on the caller's own (much
   * coarser) Trigger.dev task timeout instead of failing fast with a clear provider-level error. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const ChatCompletionBodySchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().optional() }).optional() }))
    .optional(),
  usage: z
    .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
    .optional(),
});

// Post-merge review fix (MEDIUM-2): nested LLM output was previously trusted with only shallow,
// hand-rolled duck-typing checks (e.g. `Array.isArray(parsed.sections)` with no per-element
// validation) — a malformed nested field would either pass through silently or fail later with an
// opaque TypeError/DB constraint error far from the actual cause. Full Zod schemas classify a bad
// response as a clear, provider-level error at the boundary instead.
const ReadinessAssessmentContentSchema = z.object({
  readinessResult: z.enum(['sufficient', 'sufficient_with_assumptions', 'insufficient']),
  questions: z.array(z.object({ question: z.string(), round: z.number() })).default([]),
  assumptions: z
    .array(z.object({ description: z.string(), confidence: z.enum(['high', 'medium', 'low']) }))
    .default([]),
  gaps: z
    .array(z.object({ description: z.string(), severity: z.enum(['blocking', 'non_blocking']) }))
    .default([]),
});

const PlanSectionContentSchema = z.object({
  title: z.string(),
  summary: z.string().optional(),
  sections: z.array(z.object({ title: z.string(), content: z.string() })),
});

const GeneratedFeatureSchema = z.object({
  frId: z.string(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(['feature', 'discovery']),
  priority: z.number(),
  dependsOnFrIds: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  testExpectations: z.array(
    z.object({
      description: z.string(),
      testType: z.enum(['unit', 'integration', 'system']).nullable(),
    }),
  ),
});

const FeatureBacklogContentSchema = z.object({
  features: z.array(GeneratedFeatureSchema),
});

/**
 * Plain fetch-based client against an OpenAI-compatible chat/completions endpoint — mirrors
 * `@minicoder/adapters-reviewer`'s `HttpReviewProvider` exactly, adapted for the three planner
 * calls (readiness assessment, plan-section generation, feature-backlog generation). No vendor
 * SDK dependency, consistent with core's provider-SDK-free posture even though that rule
 * technically only binds `packages/core`.
 */
export class HttpPlanProvider implements PlanProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpPlanProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`plan request failed: HTTP ${response.status}`);
    }

    const rawBody: unknown = await response.json();
    const bodyResult = ChatCompletionBodySchema.safeParse(rawBody);
    if (!bodyResult.success) {
      throw new Error(`plan response had an unexpected shape: ${bodyResult.error.message}`);
    }
    const body = bodyResult.data;
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

    const result = ReadinessAssessmentContentSchema.safeParse(content);
    if (!result.success) {
      throw new Error(`readiness response had an invalid shape: ${result.error.message}`);
    }

    return {
      ...result.data,
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

    const result = PlanSectionContentSchema.safeParse(content);
    if (!result.success) {
      throw new Error(`plan-section response had an invalid shape: ${result.error.message}`);
    }

    return {
      ...result.data,
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

    const result = FeatureBacklogContentSchema.safeParse(content);
    if (!result.success) {
      throw new Error(`feature-backlog response had an invalid shape: ${result.error.message}`);
    }

    return {
      features: result.data.features,
      tokensUsed,
      promptSnapshot: requestBody,
    };
  }
}
