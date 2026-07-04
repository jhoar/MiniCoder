import type {
  ReviewProvider,
  ReviewRequest,
  ReviewResult,
  ReviewFindingRaw,
} from './review-provider.js';

export interface HttpReviewProviderOptions {
  /** Base URL of an OpenAI-compatible chat/completions endpoint. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Plain fetch-based client against an OpenAI-compatible chat/completions endpoint — mirrors
 * `@minicoder/adapters-coder`'s `HttpCodeGenerationProvider` exactly, adapted for review prompts.
 * No vendor SDK dependency, consistent with core's provider-SDK-free posture even though that
 * rule technically only binds `packages/core`.
 */
export class HttpReviewProvider implements ReviewProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpReviewProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async review(request: ReviewRequest): Promise<ReviewResult> {
    const response = await this.fetchImpl(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [
          {
            role: 'system',
            content:
              'You are a code reviewer. Respond with a JSON object ' +
              '{"decision": "approved"|"changes_requested", "findings": [{"severity": ' +
              '"blocking"|"non_blocking"|"nit"|"question"|"out_of_scope"|"requires_human_decision", ' +
              '"category": string, "description": string, "filePath"?: string, "lineStart"?: number, ' +
              '"lineEnd"?: number}]} reviewing the given diff against the feature\'s acceptance ' +
              'criteria. No prose, JSON only.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              featureTitle: request.featureTitle,
              acceptanceCriteria: request.acceptanceCriteria,
              diff: request.diff,
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`review request failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('review response contained no message content');
    }

    let parsed: { decision?: string; findings?: ReviewFindingRaw[] };
    try {
      parsed = JSON.parse(content) as { decision?: string; findings?: ReviewFindingRaw[] };
    } catch {
      throw new Error('review response was not valid JSON');
    }
    if (parsed.decision !== 'approved' && parsed.decision !== 'changes_requested') {
      throw new Error('review response contained an invalid decision');
    }

    return {
      decision: parsed.decision,
      findings: parsed.findings ?? [],
      tokensUsed: body.usage
        ? { input: body.usage.prompt_tokens ?? 0, output: body.usage.completion_tokens ?? 0 }
        : undefined,
    };
  }
}
