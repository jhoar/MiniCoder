import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { generateId } from '@minicoder/core';
import type { ActorIdentity } from '@minicoder/core';
import { ApiKeyProvider } from './api-key-provider.js';
import { UnauthenticatedError } from '../errors.js';

const BEARER_PREFIX = 'Bearer ';

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Registers a global `onRequest` hook resolving `Authorization: Bearer <api-key>` into
 * `request.actor: ActorIdentity`. The webhook route is exempted (it authenticates via HMAC
 * signature instead — see `routes/webhooks.ts`).
 */
export function registerAuthHook(app: FastifyInstance, provider: ApiKeyProvider): void {
  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    if (request.url.startsWith('/webhooks/')) return;
    if (request.url === '/healthz' || request.url === '/readyz') return;

    const token = extractBearerToken(request);
    if (!token) {
      throw new UnauthenticatedError('Missing or malformed Authorization: Bearer <api-key> header');
    }
    const identity = provider.resolve(token);
    if (!identity) {
      throw new UnauthenticatedError('API key not recognized');
    }
    const correlationHeader = request.headers['x-correlation-id'];
    const correlationId =
      typeof correlationHeader === 'string' && correlationHeader.length > 0
        ? correlationHeader
        : generateId();
    const actor: ActorIdentity = {
      id: identity.id,
      role: identity.role,
      actorKind: identity.actorKind,
      correlationId,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
    };
    request.actor = actor;
  });
}
