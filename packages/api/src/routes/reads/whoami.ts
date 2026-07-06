import type { FastifyInstance } from 'fastify';

/**
 * `GET /whoami` (Phase 14) — echoes the resolved `request.actor` (minus the per-request
 * `correlationId`) so a client (the Ink TUI) can discover its own role/actorKind without guessing
 * from 403s. Any authenticated role may call it; it exposes nothing role-gated actions themselves
 * don't already reveal via `AuthorizationError`.
 */
export function registerWhoamiRoute(app: FastifyInstance): void {
  app.get('/whoami', async (request, reply) => {
    const actor = request.actor!;
    return reply.code(200).send({
      id: actor.id,
      role: actor.role,
      actorKind: actor.actorKind,
      ...(actor.displayName ? { displayName: actor.displayName } : {}),
    });
  });
}
