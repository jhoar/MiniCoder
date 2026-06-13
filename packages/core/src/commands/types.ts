import type { UserRole } from '../domain/states.js';
import type { DbClient } from '../persistence/types.js';
import type { ActorIdentity } from '../auth/types.js';
import type { TransitionError } from '../statemachine/validator.js';

export interface ProblemDetail {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance?: string;
}

export class CommandError extends Error {
  constructor(
    public readonly problem: ProblemDetail,
    public readonly transitionError?: TransitionError,
  ) {
    super(problem.detail);
    this.name = 'CommandError';
  }
}

export interface CommandEnvelope<P> {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly payload: P;
  readonly actor: ActorIdentity;
  readonly correlationId: string;
  readonly lockContext?: { readonly lockId: string; readonly fence: number; readonly holderId: string };
}

export interface CommandResult<S extends string = string> {
  readonly commandId: string;
  readonly accepted: boolean;
  readonly resultingState: S;
  readonly emittedEventIds: readonly string[];
}

export interface CommandHandler<P, S extends string = string> {
  readonly commandName: string;
  readonly requiredRole: UserRole;
  readonly requiredActorKind?: 'human' | 'system';
  readonly idempotencyScope: string;

  execute(envelope: CommandEnvelope<P>, db: DbClient): Promise<CommandResult<S>>;
}
