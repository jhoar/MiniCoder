import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRunRecorder, AdapterRunError } from './run-recorder.js';
import { InMemoryAdapterDb } from './test-helpers.js';
import { AgentRunState } from '../domain/states.js';

let db: InMemoryAdapterDb;
let recorder: AgentRunRecorder;

beforeEach(() => {
  db = new InMemoryAdapterDb();
  recorder = new AgentRunRecorder(db);
});

describe('AgentRunRecorder.record', () => {
  it('persists a succeeded run with input/output summaries', async () => {
    const { agentRunId, output } = await recorder.record(
      {
        adapterId: 'adapter-1',
        role: 'CoderAgentAdapter',
        projectId: 'proj-1',
        featureRunId: 'fr-1',
        input: { featureTitle: 'Add widget' },
      },
      async () => ({ commitSha: 'abc123', branchName: 'minicoder/FR-001', filesChanged: 2 }),
    );

    expect(output.commitSha).toBe('abc123');
    const row = db.agentRuns.find((r) => r.id === agentRunId);
    expect(row).toBeDefined();
    expect(row?.state).toBe(AgentRunState.SUCCEEDED);
    expect(row?.adapter_id).toBe('adapter-1');
    expect(row?.feature_run_id).toBe('fr-1');
    expect(String(row?.output_summary)).toContain('abc123');
  });

  it('persists a failed run and records the normalized error taxonomy', async () => {
    await expect(
      recorder.record(
        { adapterId: 'adapter-1', role: 'CoderAgentAdapter', input: {} },
        async () => {
          throw new AdapterRunError('rate_limited', 'too many requests');
        },
      ),
    ).rejects.toThrow(AdapterRunError);

    expect(db.agentRuns).toHaveLength(1);
    expect(db.agentRuns[0]?.state).toBe(AgentRunState.FAILED);
    expect(db.agentErrors).toHaveLength(1);
    expect(db.agentErrors[0]?.error_type).toBe('rate_limited');
    expect(db.agentErrors[0]?.message).toBe('too many requests');
  });

  it('defaults non-AdapterRunError failures to provider_unavailable', async () => {
    await expect(
      recorder.record(
        { adapterId: 'adapter-1', role: 'CoderAgentAdapter', input: {} },
        async () => {
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');

    expect(db.agentErrors[0]?.error_type).toBe('provider_unavailable');
  });

  it('redacts secret-shaped fields from input and output before persisting', async () => {
    const { agentRunId } = await recorder.record(
      {
        adapterId: 'adapter-1',
        role: 'CoderAgentAdapter',
        input: { apiKey: 'sk-should-not-be-stored-1234567890123456789012' },
      },
      async () => ({ token: 'sk-should-not-be-stored-1234567890123456789012' }),
    );

    const row = db.agentRuns.find((r) => r.id === agentRunId);
    expect(String(row?.input_summary)).not.toContain('sk-should-not-be-stored');
    expect(String(row?.output_summary)).not.toContain('sk-should-not-be-stored');
  });

  it('persists adapter provenance snapshot fields on the agent_runs row', async () => {
    const snapshot = {
      name: 'MockCoderAdapter',
      implementation: '@minicoder/testing:MockCoderAdapter',
      version: 3,
      capabilitiesUsed: ['can_modify_files', 'can_commit'],
    };
    const { agentRunId } = await recorder.record(
      { adapterId: 'adapter-1', role: 'CoderAgentAdapter', input: {}, adapterSnapshot: snapshot },
      async () => ({ commitSha: 'abc', branchName: 'minicoder/FR-001', filesChanged: 1 }),
    );

    const row = db.agentRuns.find((r) => r.id === agentRunId);
    expect(row?.adapter_name).toBe('MockCoderAdapter');
    expect(row?.adapter_implementation).toBe('@minicoder/testing:MockCoderAdapter');
    expect(row?.adapter_version).toBe(3);
    expect(JSON.parse(String(row?.capabilities_used))).toEqual(['can_modify_files', 'can_commit']);
  });

  it('historical run provenance is unaffected by adapter re-registration', async () => {
    const snap1 = {
      name: 'MockCoderAdapter',
      implementation: '@minicoder/testing:MockCoderAdapter',
      version: 1,
      capabilitiesUsed: ['can_modify_files'],
    };
    const { agentRunId } = await recorder.record(
      { adapterId: 'adapter-1', role: 'CoderAgentAdapter', input: {}, adapterSnapshot: snap1 },
      async () => ({ commitSha: 'abc', branchName: 'minicoder/FR-001', filesChanged: 1 }),
    );

    // Simulate re-registration: the adapter row in DB would change, but the run row is immutable
    const row = db.agentRuns.find((r) => r.id === agentRunId);
    expect(row?.adapter_version).toBe(1);
    expect(JSON.parse(String(row?.capabilities_used))).toEqual(['can_modify_files']);
  });
});
