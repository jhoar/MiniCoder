import { describe, it, expect } from 'vitest';
import { StateTransitionValidator, TransitionError } from './validator.js';
import { FeatureExecutionState, UserRole } from '../domain/states.js';
import type { StateMatrix } from './types.js';

const SIMPLE_MATRIX: StateMatrix<'a' | 'b' | 'c'> = [
  {
    fromState: 'a',
    toState: 'b',
    triggeringCommand: 'AtoB',
    actor: UserRole.OPERATOR,
    guardDescription: 'always allowed',
    sideEffects: [],
    emittedEvents: ['a.transitioned_to_b'],
    idempotencyKeyTemplate: 'a-to-b:{id}',
    recoveryPath: 'retry',
  },
  {
    fromState: 'b',
    toState: 'c',
    triggeringCommand: 'BtoC',
    actor: 'system',
    guardDescription: 'always allowed',
    sideEffects: [],
    emittedEvents: ['b.transitioned_to_c'],
    idempotencyKeyTemplate: 'b-to-c:{id}',
    recoveryPath: 'retry',
  },
] as const;

describe('StateTransitionValidator', () => {
  const validator = new StateTransitionValidator(SIMPLE_MATRIX, 'test-machine');

  it('assertValid returns the row for a valid transition', () => {
    const row = validator.assertValid('a', 'b');
    expect(row.triggeringCommand).toBe('AtoB');
  });

  it('assertValid throws TransitionError for an invalid transition', () => {
    expect(() => validator.assertValid('a', 'c')).toThrow(TransitionError);
    expect(() => validator.assertValid('a', 'c')).toThrow('a → c');
  });

  it('isValid returns true for valid transitions', () => {
    expect(validator.isValid('a', 'b')).toBe(true);
    expect(validator.isValid('b', 'c')).toBe(true);
  });

  it('isValid returns false for invalid transitions', () => {
    expect(validator.isValid('a', 'c')).toBe(false);
    expect(validator.isValid('c', 'a')).toBe(false);
  });

  it('validNextStates returns all valid next states', () => {
    expect(validator.validNextStates('a')).toEqual(['b']);
    expect(validator.validNextStates('b')).toEqual(['c']);
    expect(validator.validNextStates('c')).toEqual([]);
  });

  it('TransitionError message includes machine name', () => {
    let err: TransitionError | undefined;
    try {
      validator.assertValid('c', 'a');
    } catch (e) {
      err = e as TransitionError;
    }
    expect(err).toBeInstanceOf(TransitionError);
    expect(err?.machine).toBe('test-machine');
  });
});

describe('Feature execution matrix completeness', () => {
  it('every FeatureExecutionState value is a string', () => {
    const states = Object.values(FeatureExecutionState);
    expect(states.length).toBeGreaterThan(0);
    states.forEach((s) => expect(typeof s).toBe('string'));
  });
});
