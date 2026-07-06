import type { UserRole } from '@minicoder/core';

/** One configured API key, loaded from `MINICODER_API_KEYS` (see `api-key-provider.ts`). */
export interface ApiKeyConfig {
  key: string;
  id: string;
  role: UserRole;
  actorKind: 'human' | 'system';
  displayName?: string;
}

/** The resolved identity fields for a matched key, minus the per-request correlation id. */
export interface ApiKeyIdentity {
  id: string;
  role: UserRole;
  actorKind: 'human' | 'system';
  displayName?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: import('@minicoder/core').ActorIdentity;
  }
}
