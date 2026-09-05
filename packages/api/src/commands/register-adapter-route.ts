/**
 * `POST /commands/register-adapter` — the missing counterpart to `AdapterRegistry.register()`.
 * That method (and the `agent_adapters`/`agent_capabilities` tables it writes) existed since the
 * Phase 1 initial schema, but until this route, nothing in the shipped product ever called it —
 * only test fixtures did, by constructing `AdapterRegistry` in-process and calling `.register()`
 * directly. That meant every adapter-backed task (`planning-readiness-assessment`, `run-coder`,
 * `run-review`, `run-merge-gate`'s arbiter step, `run-design-doc`) was unreachable in a real
 * deployment: `AssessPlanningReadinessHandler`/etc. resolve their adapter via
 * `AdapterRegistry.resolve(role, name)`, which throws `UnknownAdapterError` when no active row
 * exists for that role+name — and there was no way to create one.
 *
 * Not dispatched through `TransactionalCommandExecutor` — adapter registration has no
 * matrix-defined state transition (`agent_adapters`/`agent_capabilities` are registry rows, not
 * state-machine entities) — so it requires `requireRole()` explicitly, the same posture
 * `repair-design-document-binding-route.ts`/`diagnostics-routes.ts` already establish for a
 * non-command administrative action. No `Idempotency-Key` header is required:
 * `AdapterRegistry.register()` is itself idempotent (`INSERT ... ON CONFLICT (role, name) DO
 * NOTHING`, falling back to an UPDATE that replaces capabilities — see its own doc comment), so a
 * retried call with the same role+name safely converges rather than needing replay protection.
 */
import type { FastifyInstance } from 'fastify';
import {
  AdapterRegistry,
  InvalidCapabilityError,
  UserRole,
  type AgentCapabilityToken,
  type DbClient,
} from '@minicoder/core';
import { RequestValidationError } from '../errors.js';
import { requireRole } from '../auth/require-role.js';

export interface RegisterAdapterRouteDeps {
  db: DbClient;
}

interface RegisterAdapterBody {
  role?: string;
  name?: string;
  implementation?: string;
  capabilities?: string[];
  isActive?: boolean;
}

export function registerRegisterAdapterRoute(
  app: FastifyInstance,
  deps: RegisterAdapterRouteDeps,
): void {
  app.post<{ Body: RegisterAdapterBody }>(
    '/commands/register-adapter',
    async (request, reply) => {
      requireRole(request, UserRole.OPERATOR, 'register-adapter');
      const { role, name, implementation, capabilities, isActive } = request.body ?? {};
      if (!role || !name || !implementation || !capabilities) {
        throw new RequestValidationError(
          'role, name, implementation, and capabilities are all required',
        );
      }

      const registry = new AdapterRegistry(deps.db);
      let adapterId: string;
      try {
        // Cast, not trust: `register()` calls `parseCapabilities()` on this array before any DB
        // write and throws `InvalidCapabilityError` (caught below) for anything not in
        // `AgentCapabilitySchema` — the real runtime validation this wire-format string[] needs.
        adapterId = await registry.register({
          role,
          name,
          implementation,
          capabilities: capabilities as AgentCapabilityToken[],
          isActive,
        });
      } catch (err) {
        // parseCapabilities() (called inside register(), before any DB write) throws this for an
        // unrecognized capability token — a caller mistake, not an infrastructure failure, so it
        // should surface as a clean 400 rather than fall through to the generic redacted 500.
        if (err instanceof InvalidCapabilityError) {
          throw new RequestValidationError(err.message, 'invalid-capability');
        }
        throw err;
      }

      return reply.code(200).send({ adapterId, role, name });
    },
  );
}
