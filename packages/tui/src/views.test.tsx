import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import {
  renderFeaturesView,
  renderHumanRequiredView,
  renderStatusView,
  renderActiveFeatureView,
  renderCommandResultView,
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
