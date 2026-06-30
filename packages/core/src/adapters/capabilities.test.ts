import { describe, it, expect } from 'vitest';
import { AgentCapabilitySchema, AgentCapabilityToken, CapabilityError, validateCapabilities } from './capabilities.js';

describe('AgentCapabilitySchema', () => {
  it('accepts all 15 canonical capability tokens', () => {
    const tokens = [
      'can_generate_plan',
      'can_generate_clarification_questions',
      'can_modify_files',
      'can_run_tests',
      'can_commit',
      'can_push_branch',
      'can_open_pull_request',
      'can_review_pull_request',
      'can_return_structured_findings',
      'can_resolve_disagreement',
      'can_generate_design_document',
      'can_report_token_usage',
      'can_report_cost',
      'can_run_asynchronously',
      'can_report_run_status',
    ];
    for (const token of tokens) {
      expect(() => AgentCapabilitySchema.parse(token)).not.toThrow();
    }
  });

  it('rejects an unknown token', () => {
    expect(() => AgentCapabilitySchema.parse('can_do_anything')).toThrow();
  });
});

describe('validateCapabilities', () => {
  it('passes when all required capabilities are declared', () => {
    expect(() =>
      validateCapabilities('adapter-1', ['can_modify_files', 'can_commit'], ['can_commit']),
    ).not.toThrow();
  });

  it('throws CapabilityError listing every missing capability', () => {
    try {
      validateCapabilities('adapter-1', ['can_modify_files'], ['can_commit', 'can_push_branch']);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CapabilityError);
      const err = e as CapabilityError;
      expect(err.adapterId).toBe('adapter-1');
      expect(err.missing).toEqual(['can_commit', 'can_push_branch']);
    }
  });

  it('passes with no required capabilities', () => {
    expect(() => validateCapabilities('adapter-1', [], [])).not.toThrow();
  });
});
