/**
 * Small, injected LLM-codegen seam (docs/06 Phase 9 "Scope decisions" #1 — the reference adapter
 * calls this interface rather than baking a vendor SDK into its core logic). Ship exactly one
 * concrete implementation (`HttpCodeGenerationProvider`, a plain-fetch OpenAI-compatible client);
 * tests use a deterministic fake of this interface instead of a real API.
 */
export interface CodeGenerationRequest {
  readonly featureTitle: string;
  readonly acceptanceCriteria: readonly string[];
  /** e.g. a file tree / relevant excerpts assembled by the adapter before calling generate(). */
  readonly repoContext: string;
}

export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}

export interface CodeGenerationResult {
  readonly files: readonly GeneratedFile[];
  readonly tokensUsed?: { readonly input: number; readonly output: number };
}

export interface CodeGenerationProvider {
  generate(request: CodeGenerationRequest): Promise<CodeGenerationResult>;
}

export interface HttpCodeGenerationProviderOptions {
  /** Base URL of an OpenAI-compatible chat/completions endpoint. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Plain fetch-based client against an OpenAI-compatible chat/completions endpoint. No vendor SDK
 * dependency, consistent with core's provider-SDK-free posture even though that rule technically
 * only binds `packages/core`. Configurable base URL so it also works with self-hosted or
 * Azure-OpenAI-compatible endpoints.
 */
export class HttpCodeGenerationProvider implements CodeGenerationProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpCodeGenerationProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(request: CodeGenerationRequest): Promise<CodeGenerationResult> {
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
              'You are a coding agent. Respond with a JSON object {"files": [{"path": string, ' +
              '"content": string}]} implementing the requested feature. No prose, JSON only.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              featureTitle: request.featureTitle,
              acceptanceCriteria: request.acceptanceCriteria,
              repoContext: request.repoContext,
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`code generation request failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('code generation response contained no message content');
    }

    let parsed: { files?: GeneratedFile[] };
    try {
      parsed = JSON.parse(content) as { files?: GeneratedFile[] };
    } catch {
      throw new Error('code generation response was not valid JSON');
    }
    if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
      throw new Error('code generation response contained no files');
    }

    return {
      files: parsed.files,
      tokensUsed: body.usage
        ? { input: body.usage.prompt_tokens ?? 0, output: body.usage.completion_tokens ?? 0 }
        : undefined,
    };
  }
}
