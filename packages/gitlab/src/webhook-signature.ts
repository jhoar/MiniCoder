/**
 * Webhook authenticity check for GitLab deliveries (docs/07-security-and-secrets.md §3.2).
 *
 * GitLab has **no HMAC signature scheme** — it authenticates a delivery with a bare shared-secret
 * token echoed back verbatim in the `X-Gitlab-Token` header. There is no signing of the request
 * body, so this check proves only "the sender knows the configured secret," not "the payload was
 * not tampered with in transit" — a materially weaker authenticity model than GitHub/Gitea's
 * HMAC-SHA256, not an equivalent one (see docs/07 §3.2's full writeup). This is why this function
 * is named `verifyGitlabWebhookToken`, not `...Signature` — there is no signature to verify, only a
 * token to compare.
 *
 * Supports the same current + previous secret rotation overlap window as the HMAC verifiers:
 * `secrets[0]` is tried first (the current secret), then any additional entries (the previous
 * secret, during a rotation window).
 */

import { timingSafeEqual } from 'crypto';

/** Constant-time comparison — never `===`, which leaks timing information about how many leading
 * bytes matched. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyGitlabWebhookToken(
  token: string | undefined | null,
  secrets: string[],
): boolean {
  if (!token) return false;
  const nonEmptySecrets = secrets.filter((s) => s.length > 0);
  if (nonEmptySecrets.length === 0) return false;
  return nonEmptySecrets.some((secret) => safeEqual(token, secret));
}
