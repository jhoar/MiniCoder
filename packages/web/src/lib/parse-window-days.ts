/**
 * PR #73 review fix (LOW-2): a manually-edited `?windowDays=` query value (e.g. `0`, a negative
 * number, `1.5`, or non-numeric text) previously passed a bare `Number.isFinite()` check straight
 * through to `ApiClient.getBudgetReport()`, turning `/costs` into an API error instead of a
 * friendly fallback. Mirrors the API/CLI's own "positive integer, else treat as unset" validation
 * — an invalid value is silently treated the same as "no window" (all-time report), never thrown.
 */
export function parseWindowDays(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
