/**
 * UX-only hint — mirrors `packages/core/src/auth/guards.ts`'s `ROLE_RANK`/`meetsRole` for the sole
 * purpose of pre-emptively hiding a button a user's role would fail server-side, avoiding a
 * pointless round trip. The backend (`assertRole`/`requireRole`) is the only real enforcement
 * point; every command-issuing Server Action still handles a 403 gracefully regardless of what
 * this check decides. Duplicated locally (rather than importing `@minicoder/core`) so this leaf
 * UI package has no runtime dependency on a backend-domain package for a one-line comparison — see
 * CLAUDE.md's "Next.js Web UI Operational Constraints" section.
 */
export type UserRole = 'viewer' | 'operator' | 'approver' | 'admin';

const ROLE_RANK: Record<UserRole, number> = {
  viewer: 0,
  operator: 1,
  approver: 2,
  admin: 3,
};

export function meetsRole(actorRole: string, requiredRole: UserRole): boolean {
  const actorRank = ROLE_RANK[actorRole as UserRole] ?? -1;
  return actorRank >= ROLE_RANK[requiredRole];
}
