/**
 * Defense-in-depth boundary sanitizer (post-merge PR review fix, LOW-1 after issue #49/HIGH-1).
 *
 * `HttpReviewProvider` (the one shipped `ReviewProvider`) now omits the PR diff from the
 * `promptSnapshot` it returns — see `packages/adapters-reviewer/src/http-review-provider.ts` — but
 * that is a contract the adapter/provider must honor, not something `run-review.ts` can enforce
 * generically over an `unknown` value. A non-compliant custom `ReviewerAgentAdapter` could still
 * report a raw diff in `promptSnapshot`, and it would be persisted into `agent_context_packs`
 * verbatim. This function is a best-effort, storage-boundary backstop: it walks the snapshot
 * (including parsing/re-serializing any JSON-shaped string values, since the shipped provider's
 * own message `content` fields are JSON-encoded strings) and replaces any string that looks like a
 * unified diff, or any value under a literal `diff` key, with a placeholder. It never throws — on
 * any unexpected shape or parse failure, the offending value is replaced with a placeholder rather
 * than persisting it unexamined or blocking the write.
 */

const DIFF_PLACEHOLDER = '[omitted by sanitizePromptSnapshot — see the stored headSha instead]';
const MAX_DEPTH = 8;

function looksLikeDiff(value: string): boolean {
  return value.includes('diff --git ') || /^(---|\+\+\+) /m.test(value) || /^@@ .* @@/m.test(value);
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return '[omitted by sanitizePromptSnapshot — max depth exceeded]';
  }

  if (typeof value === 'string') {
    // The shipped provider encodes its user message content as a JSON string, which itself often
    // contains the substring "diff --git " once escaped — checked *before* the raw-diff-string
    // heuristic below, so a JSON-shaped string is always recursed into (catching a nested `diff`
    // key) rather than being short-circuited into a single opaque placeholder that would then fail
    // to parse back as JSON for any caller expecting the original structure.
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed: unknown = JSON.parse(value);
        return JSON.stringify(sanitizeValue(parsed, depth + 1));
      } catch {
        // Not actually valid JSON despite looking bracket-shaped — fall through to the raw-string
        // diff heuristic below.
      }
    }
    if (looksLikeDiff(value)) {
      return DIFF_PLACEHOLDER;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] =
        key.toLowerCase() === 'diff' ? DIFF_PLACEHOLDER : sanitizeValue(entry, depth + 1);
    }
    return result;
  }

  return value;
}

export function sanitizePromptSnapshot(promptSnapshot: unknown): unknown {
  try {
    return sanitizeValue(promptSnapshot, 0);
  } catch {
    return '[omitted by sanitizePromptSnapshot — sanitization failed]';
  }
}
