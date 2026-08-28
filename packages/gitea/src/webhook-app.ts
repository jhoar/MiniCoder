/**
 * Minimal Fastify webhook receiver: `POST /webhooks/gitea`. Mirrors
 * `@minicoder/github`'s `webhook-app.ts` exactly, adjusted for Gitea's wire format: HMAC
 * signature verification via `verifyGiteaWebhookSignature()` (bare hex digest, no `sha256=`
 * prefix — see `./webhook-signature.ts`), `X-Gitea-Delivery` for dedup (Gitea's own delivery GUID
 * header, mirroring GitHub's `X-GitHub-Delivery`), and `X-Gitea-Event` for the event name.
 *
 * Inserts a row into `inbox_events` (`source = 'gitea'`, `dedup_key UNIQUE` gives idempotent
 * delivery handling exactly as it does for `source = 'github'`).
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { DbClient } from '@minicoder/core';
import { SCHEMA_VERSION } from '@minicoder/core';
import { verifyGiteaWebhookSignature } from './webhook-signature.js';
import { normalizeGiteaWebhookEvent } from './normalize.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/**
 * Gitea's signature is computed over the exact raw request bytes, the same requirement GitHub's
 * verifier has — Fastify's default JSON parser re-serializing `request.body` would not byte-match.
 * Exported for the same reason `@minicoder/github`'s `addRawBodyCapture` is: so the Orchestrator
 * API can install this content-type parser on its own shared Fastify instance before mounting
 * `registerGiteaWebhookRoute()`.
 */
export function addRawBodyCapture(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req: FastifyRequest, body: string, done: (err: Error | null, body?: unknown) => void) => {
      req.rawBody = body;
      try {
        done(null, body.length > 0 ? JSON.parse(body) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
}

export interface CreateGiteaWebhookAppOptions {
  db: DbClient;
  /** Current secret first, previous secret(s) after — dual-secret rotation window. */
  secrets: string[];
}

function isoNow(): string {
  return new Date().toISOString();
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function resolveProjectId(db: DbClient, repoFullName: string): Promise<string | null> {
  if (!repoFullName) return null;
  // Scoped by provider (docs/06 §Phase 18 Stage 2/3), matching @minicoder/github's identical
  // resolveProjectId() — this is Gitea's own webhook receiver, so it only ever resolves a
  // 'gitea'-provider repository row.
  const rows = await db.query<{ project_id: string }>(
    `SELECT project_id FROM repositories WHERE full_name = ? AND provider = 'gitea'`,
    [repoFullName],
  );
  return rows[0]?.project_id ?? null;
}

export async function registerGiteaWebhookRoute(
  app: FastifyInstance,
  options: CreateGiteaWebhookAppOptions,
): Promise<void> {
  app.post('/webhooks/gitea', async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = request.rawBody ?? JSON.stringify(request.body ?? {});
    const signature = request.headers['x-gitea-signature'] as string | undefined;
    const deliveryId = request.headers['x-gitea-delivery'] as string | undefined;
    const giteaEvent = request.headers['x-gitea-event'] as string | undefined;

    const verified = verifyGiteaWebhookSignature(rawBody, signature, options.secrets);
    if (!verified) {
      return reply.code(401).send({ error: 'invalid signature' });
    }
    if (!deliveryId) {
      return reply.code(400).send({ error: 'missing X-Gitea-Delivery header' });
    }
    if (!giteaEvent) {
      return reply.code(400).send({ error: 'missing X-Gitea-Event header' });
    }

    const normalized = normalizeGiteaWebhookEvent(giteaEvent, request.body);
    if (!normalized) {
      return reply.code(202).send({ status: 'ignored' });
    }

    const projectId = await resolveProjectId(options.db, normalized.repoFullName);
    if (!projectId) {
      return reply.code(202).send({ status: 'unlinked-repository' });
    }

    const now = isoNow();
    try {
      await options.db.execute(
        `INSERT INTO inbox_events
             (id, dedup_key, source, event_type, payload, payload_schema_version, status, version, created_at, updated_at)
           VALUES (?, ?, 'gitea', ?, ?, ?, 'pending', 1, ?, ?)`,
        [
          generateId(),
          deliveryId,
          normalized.eventType,
          JSON.stringify({ ...normalized.payload, projectId }),
          SCHEMA_VERSION,
          now,
          now,
        ],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/unique/i.test(msg)) throw err;
    }

    return reply.code(200).send({ status: 'accepted', eventType: normalized.eventType });
  });
}

export function createGiteaWebhookApp(options: CreateGiteaWebhookAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  addRawBodyCapture(app);
  void registerGiteaWebhookRoute(app, options);
  return app;
}
