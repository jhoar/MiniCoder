/**
 * Route-level authorization for endpoints that don't dispatch through
 * `TransactionalCommandExecutor` (which already calls `assertRole` internally via
 * `commands/generic-dispatch-route.ts`). The dedicated `merge-if-ready` route is also exempt —
 * `MergeIfReadyHandler`'s own `requiredRole = APPROVER` is enforced by the executor when that
 * route dispatches it. Everything else that mutates or exposes operational state — the
 * enqueue/task-trigger routes and the diagnostics command routes — must call this explicitly,
 * since nothing else would otherwise stop a `viewer`-role key from triggering work or mutating
 * queues/locks.
 */
import type { FastifyRequest } from 'fastify';
import { assertRole, type UserRole } from '@minicoder/core';

export function requireRole(
  request: FastifyRequest,
  requiredRole: UserRole,
  routeName: string,
): void {
  assertRole(request.actor!, requiredRole, routeName);
}
