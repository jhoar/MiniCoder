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
        capabilitiesUsed: ['can_modify_files', 'can_commit'],
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
      recorder.record(
        { adapterId, role: 'CoderAgentAdapter', input: {}, capabilitiesUsed: ['can_modify_files'] },
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
        { adapterId, role: 'CoderAgentAdapter', input: {}, capabilitiesUsed: ['can_modify_files'] },
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
        adapterId,
        role: 'CoderAgentAdapter',
        input: { apiKey: 'sk-should-not-be-stored-1234567890123456789012' },
        capabilitiesUsed: ['can_modify_files'],
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
      { adapterId, role: 'CoderAgentAdapter', input: {}, capabilitiesUsed: ['can_modify_files'] },
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
      { adapterId, role: 'CoderAgentAdapter', input: {}, capabilitiesUsed: ['can_modify_files'] },
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
      recorder.record(
        { adapterId, role: 'ReviewerAgentAdapter', input: {}, capabilitiesUsed: [] },
        async () => ({
          commitSha: 'abc',
          branchName: 'minicoder/FR-001',
          filesChanged: 1,
        }),
      ),
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

  it('capabilitiesUsed is a required field at the type level (compile-time guard)', () => {
    // @ts-expect-error capabilitiesUsed is required; omitting it must be a type error so
    // callers cannot silently produce a misleading empty capabilities_used record.
    const missingCapabilities: import('./run-recorder.js').RecordRunOptions = {
      adapterId,
      role: 'CoderAgentAdapter',
      input: {},
    };
    expect(missingCapabilities).toBeDefined();
  });
});

describe('AgentRunRecorder.record — context packs, cost/tool-operation provenance (Phase 9)', () => {
  it('writes exactly one agent_context_packs row keyed to the new agent_run_id', async () => {
    const { agentRunId } = await recorder.record(
      {
        adapterId,
        role: 'CoderAgentAdapter',
        input: {},
        capabilitiesUsed: [],
        contextPack: { content: { featureTitle: 'Add widget' } },
      },
      async () => ({ commitSha: 'abc', branchName: 'minicoder/FR-001', filesChanged: 1 }),
    );

    expect(db.agentContextPacks).toHaveLength(1);
    expect(db.agentContextPacks[0]?.agent_run_id).toBe(agentRunId);
    expect(db.agentContextPacks[0]?.content_schema_version).toBe('1.0.0');
    expect(String(db.agentContextPacks[0]?.content)).toContain('Add widget');
  });

  it('persists promptTemplateVersion on agent_runs (MEDIUM-1 code-review fix)', async () => {
    const { agentRunId } = await recorder.record(
      {
        adapterId,
        role: 'CoderAgentAdapter',
        input: {},
        capabilitiesUsed: [],
        promptTemplateVersion: 'coder-v3',
      },
      async () => ({ commitSha: 'abc', branchName: 'minicoder/FR-001', filesChanged: 1 }),
    );

    const row = db.agentRuns.find((r) => r.id === agentRunId);
    expect(row?.prompt_template_version).toBe('coder-v3');
  });

  it('leaves promptTemplateVersion null when not supplied', async () => {
    const { agentRunId } = await recorder.record(
      { adapterId, role: 'CoderAgentAdapter', input: {}, capabilitiesUsed: [] },
      async () => ({ commitSha: 'abc', branchName: 'minicoder/FR-001', filesChanged: 1 }),
    );

    const row = db.agentRuns.find((r) => r.id === agentRunId);
    expect(row?.prompt_template_version ?? null).toBeNull();
  });

  it('folds cost/token usage into agent_runs and writes one cost_records row on success', async () => {
    const { agentRunId } = await recorder.record(
      {
        adapterId,
        role: 'CoderAgentAdapter',
        projectId: 'proj-1',
        featureRunId: 'fr-1',
        featureRequestId: 'FR-001',
        input: {},
        capabilitiesUsed: [],
        costExtractor: () => ({
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.02,
          provider: 'openai-compatible',
          model: 'gpt-test',
        }),
      },
      async () => ({ commitSha: 'abc', branchName: 'minicoder/FR-001', filesChanged: 1 }),
    );

    const run = db.agentRuns.find((r) => r.id === agentRunId);
    expect(run?.tokens_used).toBe(150);
    expect(run?.cost_usd).toBe(0.02);
    expect(run?.provider).toBe('openai-compatible');
    expect(run?.model).toBe('gpt-test');

    expect(db.costRecords).toHaveLength(1);
    const record = db.costRecords[0];
    expect(record?.agent_run_id).toBe(agentRunId);
    expect(record?.project_id).toBe('proj-1');
    expect(record?.feature_request_id).toBe('FR-001');
    expect(record?.scope).toBe('feature');
    expect(record?.amount).toBe(0.02);
    expect(record?.input_tokens).toBe(100);
    expect(record?.output_tokens).toBe(50);
  });

  it('scopes the cost_records row to project when no featureRequestId is supplied', async () => {
    await recorder.record(
      {
        adapterId,
        role: 'CoderAgentAdapter',
        projectId: 'proj-1',
        input: {},
        capabilitiesUsed: [],
        costExtractor: () => ({ costUsd: 0.01 }),
      },
      async () => ({ commitSha: 'abc', branchName: 'minicoder/FR-001', filesChanged: 1 }),
    );

    expect(db.costRecords).toHaveLength(1);
    expect(db.costRecords[0]?.scope).toBe('project');
    expect(db.costRecords[0]?.feature_request_id).toBeNull();
  });

  it('does not write a cost_records row when costExtractor reports no costUsd', async () => {
    await recorder.record(
      {
        adapterId,
        role: 'CoderAgentAdapter',
        projectId: 'proj-1',
        input: {},
        capabilitiesUsed: [],
        costExtractor: () => ({ inputTokens: 10 }),
      },
      async () => ({ commitSha: 'abc', branchName: 'minicoder/FR-001', filesChanged: 1 }),
    );

    expect(db.costRecords).toHaveLength(0);
  });

  it('throws if costExtractor reports costUsd but no projectId was supplied', async () => {
    await expect(
      recorder.record(
        {
          adapterId,
          role: 'CoderAgentAdapter',
          input: {},
          capabilitiesUsed: [],
          costExtractor: () => ({ costUsd: 0.05 }),
        },
        async () => ({ commitSha: 'abc', branchName: 'minicoder/FR-001', filesChanged: 1 }),
      ),
    ).rejects.toThrow(/projectId/);
  });

  it('also invokes costExtractor on failure, recording partial usage', async () => {
    await expect(
      recorder.record(
        {
          adapterId,
          role: 'CoderAgentAdapter',
          projectId: 'proj-1',
          input: {},
          capabilitiesUsed: [],
          costExtractor: (outcome) =>
            outcome.ok ? null : { costUsd: 0.03, provider: 'openai-compatible' },
        },
        async () => {
          throw new AdapterRunError('provider_unavailable', 'boom');
        },
      ),
    ).rejects.toThrow(AdapterRunError);

    expect(db.costRecords).toHaveLength(1);
    expect(db.costRecords[0]?.amount).toBe(0.03);
    const run = db.agentRuns[0];
    expect(run?.state).toBe(AgentRunState.FAILED);
    expect(run?.cost_usd).toBe(0.03);
    expect(run?.provider).toBe('openai-compatible');
  });

  it('records agent_tool_operations rows in order from toolOperationsExtractor', async () => {
    const { agentRunId } = await recorder.record(
      {
        adapterId,
        role: 'CoderAgentAdapter',
        input: {},
        capabilitiesUsed: [],
        toolOperationsExtractor: () => [
          { toolName: 'git-clone', durationMs: 100 },
          { toolName: 'pnpm-install', durationMs: 500 },
          { toolName: 'pnpm-test', status: 'success', durationMs: 200 },
        ],
      },
      async () => ({ commitSha: 'abc', branchName: 'minicoder/FR-001', filesChanged: 1 }),
    );

    expect(db.agentToolOperations).toHaveLength(3);
    expect(db.agentToolOperations.map((r) => r.tool_name)).toEqual([
      'git-clone',
      'pnpm-install',
      'pnpm-test',
    ]);
    expect(db.agentToolOperations.every((r) => r.agent_run_id === agentRunId)).toBe(true);
  });
});
