import 'server-only';

/**
 * Reads the same two env vars `packages/tui/src/config.ts` already established for the Text UI —
 * there is exactly one Orchestrator API and one API key per deployment, so the Web UI is simply
 * another server-side client of that convention, not a reason to invent `MINICODER_WEB_*` variants.
 */
export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
}

export function resolveApiConfig(): ApiConfig {
  const baseUrl = process.env.MINICODER_API_URL;
  const apiKey = process.env.MINICODER_API_KEY;
  if (!baseUrl || !baseUrl.trim()) {
    throw new Error(
      'MINICODER_API_URL is not set — the Web UI needs the Orchestrator API base URL to render any page.',
    );
  }
  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      'MINICODER_API_KEY is not set — the Web UI needs an API key to authenticate against the Orchestrator API.',
    );
  }
  return { baseUrl, apiKey };
}
