/**
 * HMAC signature verification for Gitea webhook deliveries (docs/07-security-and-secrets.md §3.2).
 *
 * Gitea uses the same authenticity model as GitHub — HMAC-SHA256 over the raw request body — but a
 * different wire format: `X-Gitea-Signature` carries the *bare hex digest* with no `sha256=`
 * prefix, unlike GitHub's `X-Hub-Signature-256`. This is why this module hand-rolls the comparison
 * with Node's `crypto` rather than reusing `@minicoder/github`'s `verifyWebhookSignature()`
 * (built on `@octokit/webhooks-methods`, which expects GitHub's prefixed format) — the two
 * providers' signature *algorithm* is identical, but the wire format is not, and gitea peer package
 * should not depend on the github package for a one-function utility either way.
 *
 * Supports the same current + previous webhook-secret rotation overlap window as GitHub's verifier:
 * `secrets[0]` is tried first (the current secret), then any additional entries (the previous
 * secret, during a rotation window) — the delivery is accepted if it verifies against any
 * configured secret.
 */

import { createHmac, timingSafeEqual } from 'crypto';

function computeDigest(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** Constant-time comparison — the same reason GitHub's verifier avoids `===`. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyGiteaWebhookSignature(
  payload: string,
  signature: string | undefined | null,
  secrets: string[],
): boolean {
  if (!signature) return false;
  const nonEmptySecrets = secrets.filter((s) => s.length > 0);
  if (nonEmptySecrets.length === 0) return false;
  return nonEmptySecrets.some((secret) => safeEqual(computeDigest(payload, secret), signature));
}
