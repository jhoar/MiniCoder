import type { UserRole } from '../domain/states.js';

export interface ActorIdentity {
  readonly id: string;
  readonly role: UserRole;
  readonly actorKind: 'human' | 'system';
  readonly correlationId: string;
  readonly displayName?: string;
}

export interface AuthContext {
  readonly actor: ActorIdentity;
  readonly issuedAt: string;
  readonly expiresAt?: string;
}

export type RequiredRole = UserRole;

export type AuthorizationMatrix = Readonly<Record<string, RequiredRole>>;
