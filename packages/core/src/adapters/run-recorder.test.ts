import { describe, it, expect, beforeEach } from 'vitest';
import {
  AgentRunRecorder,
  AdapterRunError,
  RunRoleMismatchError,
  UndeclaredCapabilityError,
} from './run-recorder.js';
import { AdapterRegistry } from './registry.js';
import { InMemoryAdapterDb } from './test-helpers.js';
import { AgentRunState } from '../domain/states.js';

let db: InMemoryAdapterDb;
let registry: AdapterRegistry;
let recorder: AgentRunRecorder;
let adapterId: string;

beforeEach(async () => {
  db = new InMemoryAdapterDb();
  registry = new AdapterRegistry(db);
  recorder = new AgentRunRecorder(db, registry);
  adapterId = await registry.register({
    role: 'CoderAgentAdapter',
    name: 'TestAdapter',
    implementation: '@minicoder/testing:TestAdapter',
    capabilities: ['can_modify_files', 'can_commit'],
  });
});

describe('AgentRunRecorder.record', () => {
  it('persists a succeeded run with input/output summaries', async () => {
    const { agentRunId, output } = await recorder.record(
      {
        adapterId,
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
    expect(row?.adapter_id).toBe(adapterId);
    expect(row?.feature_run_id).toBe('fr-1');
    expect(String(row?.output_summary)).toContain('abc123');
  });

  it('persists a failed run and records the normalized error taxonomy', async () => {
    await expect(
      recorder.record({ adapterId, role: 'CoderAgentAdapter', input: {} }, async () => {
        throw new AdapterRunError('rate_limited', 'too many requests');
      }),
    ).rejects.toThrow(AdapterRunError);

    expect(db.agentRuns).toHaveLength(1);
    expect(db.agentRuns[0]?.state).toBe(AgentRunState.FAILED);
    expect(db.agentErrors).toHaveLength(1);
    expect(db.agentErrors[0]?.error_type).toBe('rate_limited');
    expect(db.agentErrors[0]?.message).toBe('too many requests');
  });

  it('defaults non-AdapterRunError failures to provider_unavailable', async () => {
    await expect(
      recorder.record({ adapterId, role: 'CoderAgentAdapter', input: {} }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(db.agentErrors[0]?.error_type).toBe('provider_unavailable');
  });

  it('redacts secret-shaped fields from input and output before persisting', async () => {
    const { agentRunId } = await recorder.record(
      {
        adapterId,
        role: 'CoderAgentAdapter',
        input: { apiKey: 'sk-should-not-be-stored-1234567890123456789012' },
      },
      async () => ({ token: 'sk-should-not-be-stored-1234567890123456789012' }),
    );

    const row = db.agentRuns.find((r) => r.id === agentRunId);
    expect(String(row?.input_summary)).not.toContain('sk-should-not-be-stored');
    expect(String(row?.output_summary)).not.toContain('sk-should-not-be-stored');
  });

  it('auto-resolves adapter provenance from the registry and persists it on the run row', async () => {
    const { agentRunId } = await recorder.record(
      { adapterId, role: 'CoderAgentAdapter', input: {}, capabilitiesUsed: ['can_modify_files'] },
      async () => ({ commitSha: 'abc', branchName: 'minicoder/FR-001', filesChanged: 1 }),
    );

    const row = db.agentRuns.find((r) => r.id === agentRunId);
    expect(row?.adapter_name).toBe('TestAdapter');
    expect(row?.adapter_implementation).toBe('@minicoder/testing:TestAdapter');
    expect(row?.adapter_version).toBe(1);
    expect(JSON.parse(String(row?.capabilities_used))).toEqual(['can_modify_files']);
  });

  it('snapshots registry state at invocation time so re-registration does not alter historical records', async () => {
    const { agentRunId: runId1 } = await recorder.record(
      { adapterId, role: 'CoderAgentAdapter', input: {} },
      async () => ({ commitSha: 'abc', branchName: 'minicoder/FR-001', filesChanged: 1 }),
    );

    // Re-register bumps the adapter to version 2 with a new implementation string
    await registry.register({
      role: 'CoderAgentAdapter',
      name: 'TestAdapter',
      implementation: '@minicoder/testing:TestAdapter-v2',
      capabilities: ['can_modify_files', 'can_commit', 'can_push_branch'],
    });

    const { agentRunId: runId2 } = await recorder.record(
      { adapterId, role: 'CoderAgentAdapter', input: {} },
      async () => ({ commitSha: 'def', branchName: 'minicoder/FR-002', filesChanged: 2 }),
    );

    const row1 = db.agentRuns.find((r) => r.id === runId1);
    const row2 = db.agentRuns.find((r) => r.id === runId2);
    expect(row1?.adapter_version).toBe(1);
    expect(row1?.adapter_implementation).toBe('@minicoder/testing:TestAdapter');
    expect(row2?.adapter_version).toBe(2);
    expect(row2?.adapter_implementation).toBe('@minicoder/testing:TestAdapter-v2');
  });

  it('rejects recording under a role that does not match the adapter registration', async () => {
    await expect(
      recorder.record({ adapterId, role: 'ReviewerAgentAdapter', input: {} }, async () => ({
        commitSha: 'abc',
        branchName: 'minicoder/FR-001',
        filesChanged: 1,
      })),
    ).rejects.toThrow(RunRoleMismatchError);
    expect(db.agentRuns).toHaveLength(0);
  });

  it('rejects capabilitiesUsed containing a capability the adapter did not declare', async () => {
    await expect(
      recorder.record(
        { adapterId, role: 'CoderAgentAdapter', input: {}, capabilitiesUsed: ['can_push_branch'] },
        async () => ({ commitSha: 'abc', branchName: 'minicoder/FR-001', filesChanged: 1 }),
      ),
    ).rejects.toThrow(UndeclaredCapabilityError);
    expect(db.agentRuns).toHaveLength(0);
  });

  it('accepts capabilitiesUsed that is a subset of the adapter declared capabilities', async () => {
    const { agentRunId } = await recorder.record(
      {
        adapterId,
        role: 'CoderAgentAdapter',
        input: {},
        capabilitiesUsed: ['can_modify_files', 'can_commit'],
      },
      async () => ({ commitSha: 'abc', branchName: 'minicoder/FR-001', filesChanged: 1 }),
    );
    const row = db.agentRuns.find((r) => r.id === agentRunId);
    expect(JSON.parse(String(row?.capabilities_used))).toEqual(['can_modify_files', 'can_commit']);
  });
});
