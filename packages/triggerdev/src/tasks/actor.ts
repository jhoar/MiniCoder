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

export const AUTOMATION_OPERATOR_ID = 'automation-operator';

/**
 * SelectFeatureCommand/StartCodingCommand require a human/operator actor per their handlers'
 * requiredRole/requiredActorKind (a deliberate choice — see select-feature.ts and
 * start-coding.ts — not weakened to a system actor just to simplify scheduled invocation). The
 * start-next-feature task has no real authenticated human session to attribute the run to, so it
 * uses this fixed "automation operator" identity as a placeholder until Phase 13's API layer
 * supplies real session identity, consistent with ActorPayload's own doc comment.
 */
export function automationOperatorActor(correlationId: string): ActorIdentity {
  return {
    id: AUTOMATION_OPERATOR_ID,
    role: 'operator' as UserRole,
    actorKind: 'human',
    correlationId,
  };
}
