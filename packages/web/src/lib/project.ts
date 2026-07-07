import 'server-only';
import { getApiClient } from './api-server';

/** Every page in this package is project-scoped, matching every read-model route's own
 * `projectId` requirement. Reads `?project=<id>` from the page's `searchParams`; falls back to
 * the first project returned by `/projects` when omitted (e.g. on first visit). Accepts the raw
 * `searchParams` Promise directly (Next.js 15's async request APIs — `searchParams` is a
 * `Promise` in every Server Component) so callers can pass it straight through without an
 * intermediate `await`. */
export async function resolveProjectId(
  searchParams: Promise<{ project?: string | string[] }> | { project?: string | string[] },
): Promise<string> {
  const resolved = await searchParams;
  const raw = resolved.project;
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
