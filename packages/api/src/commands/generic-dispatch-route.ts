import type { FastifyInstance } from 'fastify';
import {
  TransactionalCommandExecutor,
  generateId,
  type CommandRegistry,
  type CommandEnvelope,
  type DbClient,
} from '@minicoder/core';
import { MissingIdempotencyKeyError, NotFoundError } from '../errors.js';
import { toCommandEnvelopeResponse } from './command-response.js';
import { buildCommandSlugMap } from './registry.js';

export interface GenericDispatchDeps {
  db: DbClient;
  registry: CommandRegistry;
}

function readIdempotencyKey(header: unknown): string {
  if (typeof header !== 'string' || header.trim().length === 0) {
    throw new MissingIdempotencyKeyError();
  }
  return header;
}

/**
 * `POST /commands/:commandSlug` — generic dispatch over the populated `CommandRegistry`
 * (`registry.ts`). This is the single mechanism satisfying "no arbitrary state-mutation
 * endpoints" for every command that doesn't need its own dedicated route (see
 * `merge-if-ready-route.ts`/`task-trigger-routes.ts` for the ones that do).
 */
export function registerGenericDispatchRoute(
  app: FastifyInstance,
  deps: GenericDispatchDeps,
): void {
  const slugMap = buildCommandSlugMap(deps.registry);
  const executor = new TransactionalCommandExecutor(deps.db);

  app.post<{ Params: { commandSlug: string }; Body: Record<string, unknown> }>(
    '/commands/:commandSlug',
    async (request, reply) => {
      const commandName = slugMap.get(request.params.commandSlug);
      if (!commandName) {
        throw new NotFoundError('command', request.params.commandSlug);
      }
      const handler = deps.registry.get(commandName);
      if (!handler) {
        throw new NotFoundError('command', request.params.commandSlug);
      }
      const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);

      const envelope: CommandEnvelope<Record<string, unknown>> = {
        commandId: generateId(),
        idempotencyKey,
        payload: request.body ?? {},
        actor: request.actor!,
        correlationId: request.actor!.correlationId,
      };

      const result = await executor.execute(handler, envelope);
      return reply.code(200).send(toCommandEnvelopeResponse(result));
    },
  );

  app.get('/commands', async (_request, reply) => {
    return reply.code(200).send({ commands: Array.from(slugMap.keys()).sort() });
  });
}
