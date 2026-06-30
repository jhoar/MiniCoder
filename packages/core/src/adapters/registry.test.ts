import { describe, it, expect, beforeEach } from 'vitest';
import { AdapterRegistry, UnknownAdapterError } from './registry.js';
import { CapabilityError } from './capabilities.js';
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
});

describe('AdapterRegistry.resolve', () => {
  it('throws UnknownAdapterError for an unregistered (role, name) pair', async () => {
    await expect(registry.resolve('CoderAgentAdapter', 'NoSuchAdapter')).rejects.toThrow(
      UnknownAdapterError,
    );
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
});
