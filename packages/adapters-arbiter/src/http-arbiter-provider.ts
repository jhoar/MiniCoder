import type { ArbiterProvider, ArbitrationRequest, ArbitrationResult } from './arbiter-provider.js';

export interface HttpArbiterProviderOptions {
  /** Base URL of an OpenAI-compatible chat/completions endpoint. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Plain fetch-based client against an OpenAI-compatible chat/completions endpoint — mirrors
 * `@minicoder/adapters-reviewer`'s `HttpReviewProvider` exactly, adapted for arbitrating a
 * coder/reviewer disagreement over a repeated blocking finding. No vendor SDK dependency,
 * consistent with core's provider-SDK-free posture even though that rule technically only binds
 * `packages/core`.
 */
export class HttpArbiterProvider implements ArbiterProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpArbiterProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async arbitrate(request: ArbitrationRequest): Promise<ArbitrationResult> {
    const requestBody = {
      model: this.options.model,
      messages: [
        {
          role: 'system',
          content:
            'You are an arbiter resolving a coder/reviewer disagreement over a repeated blocking ' +
            'code review finding. Respond with a JSON object {"resolution": ' +
            '"coder_correct"|"reviewer_correct"|"compromise"|"escalate_to_human", "notes": string} ' +
            "given the finding description and both parties' positions. No prose, JSON only.",
        },
        {
          role: 'user',
          content: JSON.stringify({
            findingDescription: request.findingDescription,
            coderPosition: request.coderPosition,
            reviewerPosition: request.reviewerPosition,
          }),
        },
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
      throw new Error(`arbitration request failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('arbitration response contained no message content');
    }

    let parsed: { resolution?: string; notes?: string };
    try {
      parsed = JSON.parse(content) as { resolution?: string; notes?: string };
    } catch {
      throw new Error('arbitration response was not valid JSON');
    }
    if (
      parsed.resolution !== 'coder_correct' &&
      parsed.resolution !== 'reviewer_correct' &&
      parsed.resolution !== 'compromise' &&
      parsed.resolution !== 'escalate_to_human'
    ) {
      throw new Error('arbitration response contained an invalid resolution');
    }

    return {
      resolution: parsed.resolution,
      notes: parsed.notes ?? '',
      tokensUsed: body.usage
        ? { input: body.usage.prompt_tokens ?? 0, output: body.usage.completion_tokens ?? 0 }
        : undefined,
      promptSnapshot: requestBody,
    };
  }
}
