import type {
  DocumentationProvider,
  DocumentationRequest,
  DocumentationResult,
  DocumentationSectionResult,
} from './documentation-provider.js';

export interface HttpDocumentationProviderOptions {
  /** Base URL of an OpenAI-compatible chat/completions endpoint. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Plain fetch-based client against an OpenAI-compatible chat/completions endpoint — mirrors
 * `@minicoder/adapters-reviewer`'s `HttpReviewProvider` exactly, adapted for design-document
 * drafting. No vendor SDK dependency.
 */
export class HttpDocumentationProvider implements DocumentationProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpDocumentationProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async draft(request: DocumentationRequest): Promise<DocumentationResult> {
    const systemMessage = {
      role: 'system',
      content:
        'You are a technical writer producing a final system design document. Respond with a ' +
        'JSON object {"sections": [{"sectionName": string, "content": string}]} — one entry per ' +
        'requested section name, in the order given. No prose outside the JSON.',
    };
    const requestBody = {
      model: this.options.model,
      messages: [
        systemMessage,
        {
          role: 'user',
          content: JSON.stringify({
            projectName: request.projectName,
            projectDescription: request.projectDescription,
            featureSummaries: request.featureSummaries,
            mergedPullRequestCount: request.mergedPullRequestCount,
            sectionNames: request.sectionNames,
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
      throw new Error(`documentation drafting request failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('documentation drafting response contained no message content');
    }

    let parsed: { sections?: DocumentationSectionResult[] };
    try {
      parsed = JSON.parse(content) as { sections?: DocumentationSectionResult[] };
    } catch {
      throw new Error('documentation drafting response was not valid JSON');
    }
    if (!Array.isArray(parsed.sections)) {
      throw new Error(
        'documentation drafting response had an invalid shape: missing sections array',
      );
    }

    return {
      sections: parsed.sections,
      tokensUsed: body.usage
        ? { input: body.usage.prompt_tokens ?? 0, output: body.usage.completion_tokens ?? 0 }
        : undefined,
    };
  }
}
