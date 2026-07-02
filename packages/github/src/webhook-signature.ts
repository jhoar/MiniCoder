/**
 * HMAC signature verification for GitHub webhook deliveries (docs/07-security-and-secrets.md §5).
 *
 * Supports the current + previous webhook-secret rotation overlap window: `secrets[0]` is tried
 * first (the current secret), then any additional entries (the previous secret, during a
 * rotation window) — the delivery is accepted if it verifies against any configured secret.
 */

import { verifyWithFallback } from '@octokit/webhooks-methods';

export async function verifyWebhookSignature(
  payload: string,
  signature: string | undefined | null,
  secrets: string[],
): Promise<boolean> {
  if (!signature) return false;
  const nonEmptySecrets = secrets.filter((s) => s.length > 0);
  const primary = nonEmptySecrets[0];
  if (!primary) return false;
  const fallback = nonEmptySecrets.slice(1);
  return verifyWithFallback(primary, payload, signature, fallback);
}
