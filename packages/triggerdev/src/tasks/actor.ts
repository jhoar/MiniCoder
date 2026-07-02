import type { ActorIdentity, UserRole } from '@minicoder/core';

export const SYSTEM_ACTOR_ID = 'workflow-layer';

/** System-triggered tasks (no human in the loop) run as an admin-role system actor. */
export function systemActor(correlationId: string): ActorIdentity {
  return {
    id: SYSTEM_ACTOR_ID,
    role: 'admin' as UserRole,
    actorKind: 'system',
    correlationId,
  };
}

/** Human-initiated tasks carry the acting human's identity through the payload (Phase 13's API layer will supply this from the authenticated session instead). */
export function humanActor(opts: {
  actorId: string;
  actorRole: string;
  correlationId: string;
}): ActorIdentity {
  return {
    id: opts.actorId,
    role: opts.actorRole as UserRole,
    actorKind: 'human',
    correlationId: opts.correlationId,
  };
}
