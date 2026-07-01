import { describe, it, expect } from 'vitest';
import {
  AgentCapabilitySchema,
  CapabilityError,
  InvalidCapabilityError,
  validateCapabilities,
  parseCapabilities,
} from './capabilities.js';

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

describe('parseCapabilities', () => {
  it('returns validated tokens unchanged when all are valid', () => {
    expect(parseCapabilities(['can_modify_files', 'can_commit'], 'test')).toEqual([
      'can_modify_files',
      'can_commit',
    ]);
  });

  it('dedupes repeated tokens, preserving first-seen order', () => {
    expect(parseCapabilities(['can_commit', 'can_modify_files', 'can_commit'], 'test')).toEqual([
      'can_commit',
      'can_modify_files',
    ]);
  });

  it('throws InvalidCapabilityError listing every invalid token when given an unknown string', () => {
    try {
      parseCapabilities(['can_modify_files', 'can_do_anything', 'not_a_capability'], 'test-source');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidCapabilityError);
      const err = e as InvalidCapabilityError;
      expect(err.source).toBe('test-source');
      expect(err.invalid).toEqual(['can_do_anything', 'not_a_capability']);
    }
  });

  it('throws InvalidCapabilityError for non-string / malformed values (e.g. from corrupted DB rows)', () => {
    expect(() => parseCapabilities([null, 42, {}], 'malformed-db-row')).toThrow(
      InvalidCapabilityError,
    );
  });

  it('returns an empty array for an empty input', () => {
    expect(parseCapabilities([], 'test')).toEqual([]);
  });
});
