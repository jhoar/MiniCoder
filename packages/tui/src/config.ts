/**
 * Client-side configuration for the Ink TUI — distinct from the server's plural
 * `MINICODER_API_KEYS` (a JSON array of key configs consumed by `ApiKeyProvider`). The TUI holds
 * exactly one raw key value to send as `Authorization: Bearer <key>`, so it needs its own,
 * singular env var (see CLAUDE.md's Ink Text UI Operational Constraints and docs/07 §2/§4).
 */
export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
}

const DEFAULT_BASE_URL = 'http://localhost:4000';

export function resolveApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const apiKey = env['MINICODER_API_KEY']?.trim();
  if (!apiKey) {
    throw new Error(
      'MINICODER_API_KEY is required (the raw API key value to send as `Authorization: Bearer ' +
        '<key>` to the Orchestrator API — distinct from the server-side MINICODER_API_KEYS). ' +
        'Set it to a key configured in the running `minicoder api serve` instance.',
    );
  }
  const baseUrl = env['MINICODER_API_URL']?.trim() || DEFAULT_BASE_URL;
  return { baseUrl, apiKey };
}
