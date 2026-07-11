import { describe, it, expect } from 'vitest';
import { createTestDb } from '@minicoder/testing';
import type { DbClient } from '@minicoder/core';
import { getFeatureRunTimeline } from './timeline.js';

async function seedFeatureRun(db: DbClient, featureRunId: string): Promise<void> {
  const projectId = `proj-${featureRunId}`;
  const planId = `plan-${featureRunId}`;
  const frId = `fr-${featureRunId}`;
  await db.execute(
    `INSERT INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', 'active', 1, datetime('now'), datetime('now'))`,
    [projectId],
  );
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
    [planId, projectId],
  );
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'Feature', 'Description', 'feature', 1, 'coding', 0, 1, datetime('now'), datetime('now'))`,
    [frId, planId, projectId],
  );
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
     VALUES (?, ?, 1, 'coding', 1, datetime('now'), datetime('now'))`,
    [featureRunId, frId],
  );
}

describe('getFeatureRunTimeline', () => {
  it('merges workflow_events, agent_runs, and cost_records into one ordered timeline', async () => {
    const db = createTestDb() as unknown as DbClient;
    const featureRunId = 'run-timeline-1';
    await seedFeatureRun(db, featureRunId);
    const projectId = `proj-${featureRunId}`;

    await db.execute(
      `INSERT INTO workflow_events (id, feature_run_id, project_id, event_type, from_state, to_state, occurred_at, created_at)
       VALUES (?, ?, ?, 'feature.selected', 'approved_pending_execution', 'selected', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ['evt-1', featureRunId, projectId],
    );
    await db.execute(
      `INSERT INTO agent_adapters (id, role, name, implementation, version, is_active, created_at, updated_at)
       VALUES ('adapter-1', 'CoderAgentAdapter', 'MockCoderAdapter', 'mock', 1, 1, datetime('now'), datetime('now'))`,
    );
    await db.execute(
      `INSERT INTO agent_runs (id, adapter_id, project_id, feature_run_id, role, state, adapter_name, started_at, created_at, updated_at)
       VALUES ('run-agent-1', 'adapter-1', ?, ?, 'CoderAgentAdapter', 'succeeded', 'MockCoderAdapter', '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:00.000Z', datetime('now'))`,
      [projectId, featureRunId],
    );
    await db.execute(
      `INSERT INTO cost_records (id, project_id, feature_run_id, scope, amount, currency, recorded_at, version, created_at, updated_at)
       VALUES ('cr-1', ?, ?, 'feature', 3.5, 'USD', '2026-01-01T00:02:00.000Z', 1, datetime('now'), datetime('now'))`,
      [projectId, featureRunId],
    );

    const timeline = await getFeatureRunTimeline(db, featureRunId);
    expect(timeline.featureRunId).toBe(featureRunId);
    expect(timeline.entries.map((e) => e.kind)).toEqual(['workflow_event', 'agent_run', 'cost_record']);
    // Chronological order
    const timestamps = timeline.entries.map((e) => e.timestamp);
    expect([...timestamps].sort()).toEqual(timestamps);
  });

  it('returns an empty entry list for a feature run with no recorded history', async () => {
    const db = createTestDb() as unknown as DbClient;
    const featureRunId = 'run-timeline-empty';
    await seedFeatureRun(db, featureRunId);

    const timeline = await getFeatureRunTimeline(db, featureRunId);
    expect(timeline.entries).toEqual([]);
  });

  it('includes agent_tool_operations linked via agent_run_id', async () => {
    const db = createTestDb() as unknown as DbClient;
    const featureRunId = 'run-timeline-tools';
    await seedFeatureRun(db, featureRunId);
    const projectId = `proj-${featureRunId}`;
    await db.execute(
      `INSERT INTO agent_adapters (id, role, name, implementation, version, is_active, created_at, updated_at)
       VALUES ('adapter-2', 'CoderAgentAdapter', 'MockCoderAdapter', 'mock', 1, 1, datetime('now'), datetime('now'))`,
    );
    await db.execute(
      `INSERT INTO agent_runs (id, adapter_id, project_id, feature_run_id, role, state, created_at, updated_at)
       VALUES ('run-agent-2', 'adapter-2', ?, ?, 'CoderAgentAdapter', 'succeeded', datetime('now'), datetime('now'))`,
      [projectId, featureRunId],
    );
    await db.execute(
      `INSERT INTO agent_tool_operations (id, agent_run_id, tool_name, status, occurred_at, created_at)
       VALUES ('tool-1', 'run-agent-2', 'write_file', 'success', datetime('now'), datetime('now'))`,
    );

    const timeline = await getFeatureRunTimeline(db, featureRunId);
    expect(timeline.entries.some((e) => e.kind === 'tool_operation')).toBe(true);
  });
});
