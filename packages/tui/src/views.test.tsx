import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import {
  renderFeaturesView,
  renderHumanRequiredView,
  renderStatusView,
  renderActiveFeatureView,
  renderCommandResultView,
  renderRunsView,
  renderPlanView,
} from './views.js';

describe('views', () => {
  it('renderFeaturesView shows fr_id, title, and state for each row', () => {
    const { lastFrame } = render(
      renderFeaturesView({
        items: [
          {
            id: '1',
            plan_id: 'p1',
            project_id: 'proj1',
            fr_id: 'FR-001',
            title: 'Add widget',
            description: 'desc',
            kind: 'feature',
            executable: true,
            state: 'approved_pending_execution',
            priority: 0,
            version: 1,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        nextCursor: null,
      }),
    );
    const frame = lastFrame();
    expect(frame).toContain('FR-001');
    expect(frame).toContain('Add widget');
    // Long state tokens are truncated to keep the row within a typical 80-column terminal —
    // the prefix is enough to prove the state column rendered at all.
    expect(frame).toContain('approved_pending_exec');
  });

  it('renderFeaturesView({ full: true }) shows the full, word-wrapped description instead of the truncated table', () => {
    const longDescription =
      'Initialize TypeScript/Node.js monorepo with strict compiler settings; choose desktop shell or local web application host as described in section 21.';
    const { lastFrame } = render(
      renderFeaturesView(
        {
          items: [
            {
              id: '1',
              plan_id: 'p1',
              project_id: 'proj1',
              fr_id: 'FR-001',
              title: 'Initialize TypeScript/Node.js monorepo',
              description: longDescription,
              kind: 'feature',
              executable: true,
              state: 'approved_pending_execution',
              priority: 1,
              version: 1,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
          ],
          nextCursor: null,
        },
        { full: true },
      ),
    );
    const normalizedFrame = (lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(normalizedFrame).toContain('FR-001');
    expect(normalizedFrame).toContain(longDescription);
    expect(normalizedFrame).not.toContain('…');
  });

  it('renderFeaturesView shows "(none)" for an empty page', () => {
    const { lastFrame } = render(renderFeaturesView({ items: [], nextCursor: null }));
    expect(lastFrame()).toContain('(none)');
  });

  it('renderHumanRequiredView shows the feature run id and human_required state', () => {
    const { lastFrame } = render(
      renderHumanRequiredView({
        items: [
          {
            feature_run_id: 'run-1',
            feature_request_id: 'freq-1',
            fr_id: 'FR-002',
            title: 'Needs a human',
            current_execution_state: 'human_required',
            version: 1,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        nextCursor: null,
      }),
    );
    const frame = lastFrame();
    expect(frame).toContain('run-1');
    expect(frame).toContain('human_required');
  });

  it('renderStatusView reports project/automation state and workflow layer runs', () => {
    const { lastFrame } = render(
      renderStatusView({
        status: {
          project: { id: 'proj1', name: 'Test Project', state: 'active', version: 1 },
          workflowState: { automation_state: 'running', active_feature_run_id: null, version: 2 },
          pendingOutboxCount: 0,
        },
        whoami: { id: 'test-operator', role: 'operator', actorKind: 'human' },
        triggerdevRuns: { items: [], nextCursor: null },
      }),
    );
    const frame = lastFrame();
    expect(frame).toContain('Test Project');
    expect(frame).toContain('running');
    expect(frame).toContain('test-operator');
    expect(frame).toContain('unavailable');
  });

  it('renderActiveFeatureView shows "(none)" when no feature is active', () => {
    const { lastFrame } = render(
      renderActiveFeatureView({ automationState: 'running', activeFeatureRun: null }),
    );
    expect(lastFrame()).toContain('(none)');
  });

  it('renderActiveFeatureView shows the provider-aware PR link (docs/06 §Phase 18 Stage 6)', () => {
    const { lastFrame } = render(
      renderActiveFeatureView({
        automationState: 'running',
        activeFeatureRun: null,
        pullRequest: {
          id: 'pr-1',
          feature_run_id: 'run-1',
          pr_number: 42,
          branch_name: 'minicoder/run-1',
          base_branch: 'main',
          head_sha: 'abc123',
          state: 'open',
          review_state: 'approved',
          ci_status: 'passed',
          mergeable: true,
          blocking_labels: [],
          conversations_resolved: true,
          merged_at: null,
          merge_sha: null,
          closed_at: null,
          version: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          provider: 'gitlab',
          provider_url: 'https://gitlab.example.test/acme/widgets/-/merge_requests/42',
        },
      }),
    );
    const frame = lastFrame();
    expect(frame).toContain('View on gitlab');
    expect(frame).toContain('https://gitlab.example.test/acme/widgets/-/merge_requests/42');
  });

  it('renderRunsView tolerates a PostgreSQL NUMERIC cost_usd returned as a string', () => {
    // pg returns NUMERIC(12,6) columns as strings, not numbers — AgentRunRow's `cost_usd: number
    // | null` type is inaccurate for that dialect. This must not throw (a bare `.toFixed()` call
    // would) and should still render a formatted amount.
    const { lastFrame } = render(
      renderRunsView({
        items: [
          {
            id: 'run-1',
            adapter_id: 'adapter-1',
            project_id: 'proj1',
            feature_run_id: 'fr-run-1',
            role: 'coder',
            state: 'succeeded',
            input_summary: null,
            output_summary: null,
            error: null,
            started_at: null,
            ended_at: null,
            tokens_used: null,
            cost_usd: '0.030000' as unknown as number,
            version: 1,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        nextCursor: null,
      }),
    );
    const frame = lastFrame();
    expect(frame).toContain('coder');
    expect(frame).toContain('0.0300');
  });

  it('renderRunsView shows "-" for a null cost_usd', () => {
    const { lastFrame } = render(
      renderRunsView({
        items: [
          {
            id: 'run-2',
            adapter_id: 'adapter-1',
            project_id: 'proj1',
            feature_run_id: null,
            role: 'reviewer',
            state: 'running',
            input_summary: null,
            output_summary: null,
            error: null,
            started_at: null,
            ended_at: null,
            tokens_used: null,
            cost_usd: null,
            version: 1,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        nextCursor: null,
      }),
    );
    expect(lastFrame()).toContain('reviewer');
  });

  it('renderPlanView shows plan title/summary/state and full section content when planDetail is given', () => {
    const { lastFrame } = render(
      renderPlanView({
        plans: { items: [], nextCursor: null },
        readiness: { items: [], nextCursor: null },
        planDetail: {
          plan: {
            id: 'plan-1',
            project_id: 'proj1',
            assessment_id: 'assessment-1',
            state: 'draft',
            title: 'Open Narrative Studio Implementation Plan',
            summary: 'A local-first writing and narrative-planning application.',
            version: 1,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
          sections: [
            {
              id: 'section-1',
              title: 'Data Model',
              content: 'Define the entity-and-relationship model described in section 7.',
              order_index: 0,
            },
          ],
        },
      }),
    );
    // Whitespace-normalized, same as DescriptionList's own word-wrap test — long content wraps
    // across lines rather than appearing as one unbroken line.
    const normalizedFrame = (lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(normalizedFrame).toContain('Open Narrative Studio Implementation Plan');
    expect(normalizedFrame).toContain('A local-first writing and narrative-planning application.');
    expect(normalizedFrame).toContain('Data Model');
    expect(normalizedFrame).toContain(
      'Define the entity-and-relationship model described in section 7.',
    );
  });

  it('renderCommandResultView shows the resulting state after pause/resume', () => {
    const { lastFrame } = render(
      renderCommandResultView({
        command: 'pause-automation',
        projectId: 'proj1',
        resultingState: 'paused_by_operator',
      }),
    );
    const frame = lastFrame();
    expect(frame).toContain('pause-automation');
    expect(frame).toContain('paused_by_operator');
  });
});
