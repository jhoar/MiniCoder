import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import {
  renderFeaturesView,
  renderHumanRequiredView,
  renderStatusView,
  renderActiveFeatureView,
  renderCommandResultView,
  renderRunsView,
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
          project: { id: 'proj1', name: 'Test Project', state: 'active' },
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
