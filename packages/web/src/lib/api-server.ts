import 'server-only';

/**
 * The `server-only`-guarded entry point every Server Component/Server Action imports — makes an
 * accidental Client Component import of the Orchestrator API client a build error rather than a
 * silent API-key leak into the browser bundle (see CLAUDE.md's "Next.js Web UI Operational
 * Constraints" section). The actual `ApiClient` class lives in `./api-client.ts`, which has no
 * `server-only` import so unit tests can construct it directly with a fake `fetchImpl`.
 */
import { ApiClient } from './api-client';
import { resolveApiConfig } from './config';

export * from './api-client';

let cachedClient: ApiClient | undefined;

/** Server Components/Actions call this instead of constructing `ApiClient` directly — reads env
 * once per resolution and reuses the instance across a request. */
export function getApiClient(): ApiClient {
  if (!cachedClient) {
    const config = resolveApiConfig();
    cachedClient = new ApiClient(config);
  }
  return cachedClient;
}
