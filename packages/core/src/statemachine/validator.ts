import type { StateMatrix, TransitionRow } from './types.js';

export class TransitionError extends Error {
  constructor(
    public readonly fromState: string,
    public readonly toState: string,
    public readonly machine: string,
  ) {
    super(`Invalid transition in ${machine}: ${fromState} → ${toState}`);
    this.name = 'TransitionError';
  }
}

export class StateTransitionValidator<S extends string> {
  private readonly lookup: Map<string, TransitionRow<S, S>>;

  constructor(
    private readonly matrix: StateMatrix<S>,
    private readonly machineName: string,
  ) {
    this.lookup = new Map(matrix.map((row) => [`${row.fromState}→${row.toState}`, row]));
  }

  assertValid(from: S, to: S): TransitionRow<S, S> {
    const key = `${from}→${to}`;
    const row = this.lookup.get(key);
    if (!row) {
      throw new TransitionError(from, to, this.machineName);
    }
    return row;
  }

  isValid(from: S, to: S): boolean {
    return this.lookup.has(`${from}→${to}`);
  }

  validNextStates(from: S): readonly S[] {
    const result: S[] = [];
    for (const row of this.matrix) {
      if (row.fromState === from) {
        result.push(row.toState);
      }
    }
    return result;
  }
}
