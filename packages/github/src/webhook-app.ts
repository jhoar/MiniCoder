/**
 * Minimal Fastify webhook receiver: `POST /webhooks/github`.
 *
 * Verifies the HMAC signature (current + previous secret during rotation overlap), dedups on
 * `X-GitHub-Delivery`, normalizes the raw GitHub event into MiniCoder's internal event-type
 * taxonomy, and inserts a row into `inbox_events` (`source = 'github'`, `dedup_key UNIQUE`
 * already gives idempotent delivery handling — a redelivered GUID hits the unique-constraint
 * conflict and is silently accepted as already-recorded).
 *
 * This app is intentionally standalone (Phase 7 ships no Fastify orchestrator API yet — that is
 * Phase 13 scope). Phase 13 mounts `registerGithubWebhookRoute()` inside the full API instead of
 * re-implementing this handler.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { DbClient } from '@minicoder/core';
import { SCHEMA_VERSION } from '@minicoder/core';
import { verifyWebhookSignature } from './webhook-signature.js';
import { normalizeGithubWebhookEvent } from './normalize.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/**
 * GitHub's signature is computed over the exact raw request bytes — Fastify's default JSON
 * parser re-serializing `request.body` would not byte-match, silently breaking verification.
 * This content-type parser captures the raw string on `request.rawBody` before parsing JSON.
 */
function addRawBodyCapture(app: FastifyInstance): void {
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

export interface CreateWebhookAppOptions {
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
  const rows = await db.query<{ project_id: string }>(
    `SELECT project_id FROM repositories WHERE full_name = ?`,
    [repoFullName],
  );
  return rows[0]?.project_id ?? null;
}

export async function registerGithubWebhookRoute(
  app: FastifyInstance,
  options: CreateWebhookAppOptions,
): Promise<void> {
  app.post('/webhooks/github', async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = request.rawBody ?? JSON.stringify(request.body ?? {});
    const signature = request.headers['x-hub-signature-256'] as string | undefined;
    const deliveryId = request.headers['x-github-delivery'] as string | undefined;
    const githubEvent = request.headers['x-github-event'] as string | undefined;

    const verified = await verifyWebhookSignature(rawBody, signature, options.secrets);
    if (!verified) {
      return reply.code(401).send({ error: 'invalid signature' });
    }
    if (!deliveryId) {
      return reply.code(400).send({ error: 'missing X-GitHub-Delivery header' });
    }
    if (!githubEvent) {
      return reply.code(400).send({ error: 'missing X-GitHub-Event header' });
    }

    const normalized = normalizeGithubWebhookEvent(githubEvent, request.body);
    if (!normalized) {
      // Event/action combination MiniCoder does not act on — acknowledge without persisting.
      return reply.code(202).send({ status: 'ignored' });
    }

    const projectId = await resolveProjectId(options.db, normalized.repoFullName);
    if (!projectId) {
      // Repository not linked to a MiniCoder project — acknowledge without persisting.
      return reply.code(202).send({ status: 'unlinked-repository' });
    }

    const now = isoNow();
    try {
      await options.db.execute(
        `INSERT INTO inbox_events
             (id, dedup_key, source, event_type, payload, payload_schema_version, status, version, created_at, updated_at)
           VALUES (?, ?, 'github', ?, ?, ?, 'pending', 1, ?, ?)`,
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
      // dedup_key UNIQUE conflict = this delivery GUID was already recorded (GitHub retry).
      const msg = err instanceof Error ? err.message : String(err);
      if (!/unique/i.test(msg)) throw err;
    }

    return reply.code(200).send({ status: 'accepted', eventType: normalized.eventType });
  });
}

export function createWebhookApp(options: CreateWebhookAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  addRawBodyCapture(app);
  void registerGithubWebhookRoute(app, options);
  return app;
}
