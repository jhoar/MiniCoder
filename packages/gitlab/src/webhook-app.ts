/**
 * Minimal Fastify webhook receiver: `POST /webhooks/gitlab`. Mirrors `@minicoder/github`'s and
 * `@minicoder/gitea`'s `webhook-app.ts`, adjusted for GitLab's wire format:
 *
 *   - Authenticity: `X-Gitlab-Token` compared via `verifyGitlabWebhookToken()`'s constant-time
 *     string check — GitLab has no HMAC signature scheme (see `./webhook-signature.ts`).
 *   - Event kind: read from the parsed body's own `object_kind` field (`"merge_request"` /
 *     `"pipeline"` / `"note"`), not the `X-Gitlab-Event` header — that header carries a
 *     human-readable string ("Merge Request Hook") in a different format than `object_kind`'s
 *     machine-readable slug, and `normalizeGitlabWebhookEvent()` is written against the latter.
 *   - Delivery dedup: **GitLab sends no delivery-GUID header** the way GitHub's
 *     `X-GitHub-Delivery`/Gitea's `X-Gitea-Delivery` do — a real, documented gap, not an oversight.
 *     This receiver falls back to a SHA-256 hash of the raw request body as the `dedup_key`. This
 *     correctly collapses an exact-duplicate redelivery (the common case: GitLab retries an
 *     unacknowledged webhook with byte-identical content) but would **not** catch two distinct
 *     GitLab deliveries that happen to differ only in a field this hash doesn't need to be aware
 *     of — there is no such case in the payload shapes this receiver actually parses, but this is
 *     a documented limitation of hash-based dedup versus a real delivery ID, not a guarantee.
 *
 * Inserts a row into `inbox_events` (`source = 'gitlab'`, `dedup_key UNIQUE` gives idempotent
 * delivery handling for the exact-duplicate case above).
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { DbClient } from '@minicoder/core';
import { SCHEMA_VERSION } from '@minicoder/core';
import { createHash } from 'crypto';
import { verifyGitlabWebhookToken } from './webhook-signature.js';
import { normalizeGitlabWebhookEvent } from './normalize.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

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

export interface CreateGitlabWebhookAppOptions {
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

function hashDeliveryDedupKey(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

async function resolveProjectId(db: DbClient, repoFullName: string): Promise<string | null> {
  if (!repoFullName) return null;
  const rows = await db.query<{ project_id: string }>(
    `SELECT project_id FROM repositories WHERE full_name = ? AND provider = 'gitlab'`,
    [repoFullName],
  );
  return rows[0]?.project_id ?? null;
}

export async function registerGitlabWebhookRoute(
  app: FastifyInstance,
  options: CreateGitlabWebhookAppOptions,
): Promise<void> {
  app.post('/webhooks/gitlab', async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = request.rawBody ?? JSON.stringify(request.body ?? {});
    const token = request.headers['x-gitlab-token'] as string | undefined;

    const verified = verifyGitlabWebhookToken(token, options.secrets);
    if (!verified) {
      return reply.code(401).send({ error: 'invalid token' });
    }

    const body = request.body as { object_kind?: string } | undefined;
    const objectKind = body?.object_kind;
    if (!objectKind) {
      return reply.code(400).send({ error: 'missing object_kind in payload' });
    }

    const normalized = normalizeGitlabWebhookEvent(objectKind, request.body);
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
           VALUES (?, ?, 'gitlab', ?, ?, ?, 'pending', 1, ?, ?)`,
        [
          generateId(),
          hashDeliveryDedupKey(rawBody),
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

export function createGitlabWebhookApp(options: CreateGitlabWebhookAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  addRawBodyCapture(app);
  void registerGitlabWebhookRoute(app, options);
  return app;
}
