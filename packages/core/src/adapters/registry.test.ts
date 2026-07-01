import { describe, it, expect, beforeEach } from 'vitest';
import { AdapterRegistry, UnknownAdapterError } from './registry.js';
import { CapabilityError, InvalidCapabilityError } from './capabilities.js';
import { InMemoryAdapterDb } from './test-helpers.js';

let db: InMemoryAdapterDb;
let registry: AdapterRegistry;

beforeEach(() => {
  db = new InMemoryAdapterDb();
  registry = new AdapterRegistry(db);
});

describe('AdapterRegistry.register', () => {
  it('registers a new adapter with its declared capabilities', async () => {
    const adapterId = await registry.register({
      role: 'CoderAgentAdapter',
      name: 'MockCoderAdapter',
      implementation: 'mock',
      capabilities: ['can_modify_files', 'can_commit', 'can_push_branch'],
    });

    const record = await registry.resolve('CoderAgentAdapter', 'MockCoderAdapter');
    expect(record.id).toBe(adapterId);
    expect(record.isActive).toBe(true);
    expect(record.version).toBe(1);
    expect(record.capabilities).toEqual(['can_modify_files', 'can_commit', 'can_push_branch']);
  });

  it('concurrent registration via ON CONFLICT DO NOTHING: second caller gets same id and updates', async () => {
    // Simulate what happens when a second caller's INSERT hits the DO NOTHING path:
    // the InMemoryAdapterDb skips the duplicate insert, and the re-select returns the first ID.
    const firstId = await registry.register({
      role: 'CoderAgentAdapter',
      name: 'ConcurrentAdapter',
      implementation: 'v1',
      capabilities: ['can_modify_files'],
    });
    // Second registration for the same (role, name) — simulates the concurrent winner path
    const secondId = await registry.register({
      role: 'CoderAgentAdapter',
      name: 'ConcurrentAdapter',
      implementation: 'v2',
      capabilities: ['can_modify_files', 'can_commit'],
    });

    expect(secondId).toBe(firstId);
    const record = await registry.getById(firstId);
    expect(record.implementation).toBe('v2');
    expect(record.version).toBe(2);
    expect(record.capabilities).toEqual(['can_modify_files', 'can_commit']);
  });

  it('re-registering the same (role, name) replaces capabilities rather than duplicating the adapter', async () => {
    const firstId = await registry.register({
      role: 'ReviewerAgentAdapter',
      name: 'MockReviewerAdapter',
      implementation: 'mock',
      capabilities: ['can_review_pull_request'],
    });
    const secondId = await registry.register({
      role: 'ReviewerAgentAdapter',
      name: 'MockReviewerAdapter',
      implementation: 'mock-v2',
      capabilities: ['can_review_pull_request', 'can_return_structured_findings'],
    });

    expect(secondId).toBe(firstId);
    const record = await registry.getById(firstId);
    expect(record.implementation).toBe('mock-v2');
    expect(record.version).toBeGreaterThan(1);
    expect(record.capabilities).toEqual([
      'can_review_pull_request',
      'can_return_structured_findings',
    ]);
  });

  it('rejects registration with an unknown capability token', async () => {
    await expect(
      registry.register({
        role: 'CoderAgentAdapter',
        name: 'BadAdapter',
        implementation: 'mock',
        // @ts-expect-error deliberately passing a token outside AgentCapabilityToken
        capabilities: ['can_modify_files', 'can_do_anything'],
      }),
    ).rejects.toThrow(InvalidCapabilityError);
    // No adapter row should be persisted when capability validation fails.
    await expect(registry.resolve('CoderAgentAdapter', 'BadAdapter')).rejects.toThrow(
      UnknownAdapterError,
    );
  });

  it('dedupes duplicate capability tokens on registration', async () => {
    const adapterId = await registry.register({
      role: 'CoderAgentAdapter',
      name: 'DedupeAdapter',
      implementation: 'mock',
      capabilities: ['can_modify_files', 'can_commit', 'can_modify_files'],
    });
    const record = await registry.getById(adapterId);
    expect(record.capabilities).toEqual(['can_modify_files', 'can_commit']);
  });
});

describe('AdapterRegistry.resolve', () => {
  it('throws UnknownAdapterError for an unregistered (role, name) pair', async () => {
    await expect(registry.resolve('CoderAgentAdapter', 'NoSuchAdapter')).rejects.toThrow(
      UnknownAdapterError,
    );
  });

  it('fails loudly on a malformed capability row read back from the database', async () => {
    const adapterId = await registry.register({
      role: 'CoderAgentAdapter',
      name: 'CorruptedAdapter',
      implementation: 'mock',
      capabilities: ['can_modify_files'],
    });
    // Simulate DB-level corruption (e.g. a hand-written migration or direct DB edit) bypassing
    // the registry's own validation — the read path must not silently cast this to a token.
    db.agentCapabilities.push({
      id: 'corrupt-cap',
      adapter_id: adapterId,
      capability: 'not_a_real_capability',
    });
    await expect(registry.getById(adapterId)).rejects.toThrow(InvalidCapabilityError);
  });

  it('returns capabilities in canonical schema order regardless of physical row insertion order', async () => {
    const adapterId = await registry.register({
      role: 'CoderAgentAdapter',
      name: 'PhysicalOrderAdapter',
      implementation: 'mock',
      capabilities: [],
    });
    // Bypass the registry's own insertion order and write rows directly in reverse canonical
    // order ('can_push_branch' precedes 'can_commit' precedes 'can_modify_files' physically).
    // toRecord() must not depend on row order — it sorts by AgentCapabilitySchema position.
    db.agentCapabilities.push(
      { id: 'cap-1', adapter_id: adapterId, capability: 'can_push_branch' },
      { id: 'cap-2', adapter_id: adapterId, capability: 'can_commit' },
      { id: 'cap-3', adapter_id: adapterId, capability: 'can_modify_files' },
    );

    const record = await registry.getById(adapterId);
    expect(record.capabilities).toEqual(['can_modify_files', 'can_commit', 'can_push_branch']);
  });

  it('does not resolve an inactive adapter', async () => {
    await registry.register({
      role: 'CoderAgentAdapter',
      name: 'RetiredAdapter',
      implementation: 'mock',
      capabilities: [],
      isActive: false,
    });
    await expect(registry.resolve('CoderAgentAdapter', 'RetiredAdapter')).rejects.toThrow(
      UnknownAdapterError,
    );
  });
});

describe('AdapterRegistry.assertCapabilities', () => {
  it('passes when the adapter declares every required capability', async () => {
    const adapterId = await registry.register({
      role: 'CoderAgentAdapter',
      name: 'MockCoderAdapter',
      implementation: 'mock',
      capabilities: ['can_modify_files', 'can_commit', 'can_push_branch'],
    });
    await expect(
      registry.assertCapabilities(adapterId, ['can_modify_files', 'can_commit']),
    ).resolves.not.toThrow();
  });

  it('throws CapabilityError when a required capability is undeclared', async () => {
    const adapterId = await registry.register({
      role: 'CoderAgentAdapter',
      name: 'MockCoderAdapter',
      implementation: 'mock',
      capabilities: ['can_modify_files'],
    });
    await expect(registry.assertCapabilities(adapterId, ['can_open_pull_request'])).rejects.toThrow(
      CapabilityError,
    );
  });
});

describe('AdapterRegistry.getConfiguration', () => {
  it('returns null when no configuration row exists', async () => {
    const adapterId = await registry.register({
      role: 'CoderAgentAdapter',
      name: 'MockCoderAdapter',
      implementation: 'mock',
      capabilities: [],
    });
    expect(await registry.getConfiguration(adapterId)).toBeNull();
  });

  it('prefers a project-scoped configuration over the adapter default', async () => {
    const adapterId = await registry.register({
      role: 'CoderAgentAdapter',
      name: 'MockCoderAdapter',
      implementation: 'mock',
      capabilities: [],
    });
    db.agentConfigurations.push(
      {
        id: 'cfg-default',
        adapter_id: adapterId,
        project_id: null,
        config: JSON.stringify({ tier: 'default' }),
      },
      {
        id: 'cfg-proj',
        adapter_id: adapterId,
        project_id: 'proj-1',
        config: JSON.stringify({ tier: 'project' }),
      },
    );

    expect(await registry.getConfiguration(adapterId, 'proj-1')).toEqual({ tier: 'project' });
    expect(await registry.getConfiguration(adapterId, 'proj-2')).toEqual({ tier: 'default' });
  });

  it('deterministically picks the highest version/most-recently-updated row if duplicates exist', async () => {
    // Migration 0006 prevents this at the schema level, but the read path stays deterministic
    // (version DESC, updated_at DESC) as defense-in-depth against any direct DB write that
    // bypasses the registry and schema constraint.
    const adapterId = await registry.register({
      role: 'CoderAgentAdapter',
      name: 'MockCoderAdapter',
      implementation: 'mock',
      capabilities: [],
    });
    db.agentConfigurations.push(
      {
        id: 'cfg-old',
        adapter_id: adapterId,
        project_id: null,
        version: 1,
        updated_at: '2026-01-01T00:00:00Z',
        config: JSON.stringify({ tier: 'stale' }),
      },
      {
        id: 'cfg-new',
        adapter_id: adapterId,
        project_id: null,
        version: 2,
        updated_at: '2026-06-01T00:00:00Z',
        config: JSON.stringify({ tier: 'current' }),
      },
    );

    expect(await registry.getConfiguration(adapterId)).toEqual({ tier: 'current' });
  });
});
