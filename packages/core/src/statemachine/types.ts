import type { UserRole } from '../domain/states.js';
import type { TxClient } from '../persistence/types.js';
import type { ActorIdentity } from '../auth/types.js';

export interface TransitionGuardContext {
  readonly projectId?: string;
  readonly featureRunId?: string;
  readonly db: TxClient;
  readonly actor: ActorIdentity;
}

export interface TransitionRow<
  FromState extends string,
  ToState extends string,
> {
  readonly fromState: FromState;
  readonly toState: ToState;
  readonly triggeringCommand: string;
  readonly actor: UserRole | 'system';
  readonly guardDescription: string;
  readonly guard?: (ctx: TransitionGuardContext) => Promise<boolean>;
  readonly sideEffects: readonly string[];
  readonly emittedEvents: readonly string[];
  readonly idempotencyKeyTemplate: string;
  readonly recoveryPath: string;
}

export type StateMatrix<S extends string> = ReadonlyArray<TransitionRow<S, S>>;
