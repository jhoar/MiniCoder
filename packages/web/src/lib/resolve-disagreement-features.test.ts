import { describe, it, expect, vi } from 'vitest';
import type { DisagreementRow } from '@minicoder/api';
import { ApiClient } from './api-client';
import { resolveDisagreementFeatures } from './resolve-disagreement-features';

/** Regression for MEDIUM-6: the disagreements page used to link into `/features/{feature_run_id}`
 * — a 404, since `/features/[id]` expects a feature *request* ID. This fixture deliberately uses
 * distinct run/request/project IDs (never equal by coincidence) so the test only passes if the
 * resolution genuinely routes through `getFeatureRun` -> `getFeature`, not by accident. */
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const body = routes[path];
    if (body === undefined) {
      throw new Error(`unexpected request: ${path}`);
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('resolveDisagreementFeatures', () => {
  it('resolves each disagreement to its feature *request* ID and real project ID, not the run ID', async () => {
    const disagreement: DisagreementRow = {
      id: 'disagreement-1',
      feature_run_id: 'run-999', // deliberately distinct from the feature request id below
      finding_id: null,
      review_cycle: 1,
      state: 'open',
      arbiter_run_id: null,
      resolution: null,
      resolved_at: null,
      version: 1,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };

    const client = new ApiClient({
      baseUrl: 'http://api.local',
      apiKey: 'k',
      fetchImpl: fakeFetch({
        '/feature-runs/run-999': {
          id: 'run-999',
          feature_request_id: 'feature-req-42',
          attempt_no: 1,
          current_execution_state: 'human_required',
          lock_id: null,
          started_at: null,
          ended_at: null,
          outcome: null,
          version: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        '/features/feature-req-42': {
          feature: {
            id: 'feature-req-42',
            plan_id: 'plan-1',
            project_id: 'project-other', // deliberately not the currently-selected project
            fr_id: 'FR-042',
            title: 'Test feature',
            description: 'desc',
            kind: 'feature',
            executable: true,
            state: 'approved',
            priority: 1,
            version: 1,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
          runs: [],
        },
      }),
    });

    const [resolved] = await resolveDisagreementFeatures(client, [disagreement]);

    expect(resolved.featureRequestId).toBe('feature-req-42');
    expect(resolved.featureProjectId).toBe('project-other');
    // The original disagreement fields (including the run id) are preserved alongside the
    // resolved ones — the fix adds fields, it doesn't replace the row.
    expect(resolved.feature_run_id).toBe('run-999');
  });
});
