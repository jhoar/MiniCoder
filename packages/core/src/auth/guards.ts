import { UserRole } from '../domain/states.js';
import type { ActorIdentity } from './types.js';

const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.VIEWER]: 0,
  [UserRole.OPERATOR]: 1,
  [UserRole.APPROVER]: 2,
  [UserRole.ADMIN]: 3,
};

export class AuthorizationError extends Error {
  constructor(
    public readonly actorId: string,
    public readonly actorRole: UserRole,
    public readonly requiredRole: UserRole,
    public readonly command: string,
  ) {
    super(
      `Actor ${actorId} with role '${actorRole}' is not authorized to execute '${command}' (requires '${requiredRole}')`,
    );
    this.name = 'AuthorizationError';
  }
}

export function meetsRole(actorRole: UserRole, requiredRole: UserRole): boolean {
  return ROLE_RANK[actorRole] >= ROLE_RANK[requiredRole];
}

export function assertRole(
  actor: ActorIdentity,
  requiredRole: UserRole,
  command: string,
): void {
  if (!meetsRole(actor.role, requiredRole)) {
    throw new AuthorizationError(actor.id, actor.role, requiredRole, command);
  }
}
