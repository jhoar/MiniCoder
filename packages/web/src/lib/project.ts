import 'server-only';
import { getApiClient } from './api-server';

/** Every page in this package is project-scoped, matching every read-model route's own
 * `projectId` requirement. Reads `?project=<id>` from the page's `searchParams`; falls back to
 * the first project returned by `/projects` when omitted (e.g. on first visit). */
export async function resolveProjectId(searchParams: {
  project?: string | string[];
}): Promise<string> {
  const raw = searchParams.project;
  const fromQuery = Array.isArray(raw) ? raw[0] : raw;
  if (fromQuery) return fromQuery;

  const client = getApiClient();
  const page = await client.listProjects({ limit: '1' });
  const first = page.items[0];
  if (!first) {
    throw new Error('No projects exist yet — ingest a specification to create one.');
  }
  return first.id;
}
