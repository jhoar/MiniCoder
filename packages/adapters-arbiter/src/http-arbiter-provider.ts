import { z } from 'zod';
import type { ArbiterProvider, ArbitrationRequest, ArbitrationResult } from './arbiter-provider.js';

export interface HttpArbiterProviderOptions {
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

// Post-merge review fix (MEDIUM-2): validate the parsed arbitration decision with a real schema
// rather than a hand-rolled equality chain, matching the treatment given to
// @minicoder/adapters-planner's nested LLM output for the same reason (a malformed response should
// classify as a clear provider-level error, not an opaque failure further downstream).
const ArbitrationContentSchema = z.object({
  resolution: z.enum(['coder_correct', 'reviewer_correct', 'compromise', 'escalate_to_human']),
  notes: z.string().default(''),
});

/**
 * Plain fetch-based client against an OpenAI-compatible chat/completions endpoint — mirrors
 * `@minicoder/adapters-reviewer`'s `HttpReviewProvider` exactly, adapted for arbitrating a
 * coder/reviewer disagreement over a repeated blocking finding. No vendor SDK dependency,
 * consistent with core's provider-SDK-free posture even though that rule technically only binds
 * `packages/core`.
 */
export class HttpArbiterProvider implements ArbiterProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpArbiterProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`arbitration request failed: HTTP ${response.status}`);
    }

    const rawBody: unknown = await response.json();
    const bodyResult = ChatCompletionBodySchema.safeParse(rawBody);
    if (!bodyResult.success) {
      throw new Error(`arbitration response had an unexpected shape: ${bodyResult.error.message}`);
    }
    const body = bodyResult.data;
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('arbitration response contained no message content');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      throw new Error('arbitration response was not valid JSON');
    }

    const result = ArbitrationContentSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new Error(`arbitration response had an invalid shape: ${result.error.message}`);
    }

    return {
      resolution: result.data.resolution,
      notes: result.data.notes,
      tokensUsed: body.usage
        ? { input: body.usage.prompt_tokens ?? 0, output: body.usage.completion_tokens ?? 0 }
        : undefined,
      promptSnapshot: requestBody,
    };
  }
}
