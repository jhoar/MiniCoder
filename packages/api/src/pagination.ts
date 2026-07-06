/**
 * Cursor pagination (docs/01-system-specification.md §9: `?cursor=&limit=` with `next_cursor`).
 * Every list read-model shares this helper rather than hand-rolling `LIMIT`/`OFFSET` per group.
 */
import type { DbClient } from '@minicoder/core';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface ListParams {
  cursor?: string;
  limit?: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

interface CursorPosition {
  createdAt: string;
  id: string;
}

export function resolveLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
}

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id }), 'utf-8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPosition | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>)['c'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['i'] === 'string'
    ) {
      return { createdAt: (parsed as { c: string }).c, id: (parsed as { i: string }).i };
    }
  } catch {
    // fall through — malformed cursors are treated as "start from the beginning"
  }
  return null;
}

interface ListQueryOptions {
  table: string;
  columns: string;
  /** Extra WHERE predicate (without the leading WHERE/AND), already using `?` placeholders. */
  where?: string;
  params?: unknown[];
}

interface RowWithCursor {
  created_at: string;
  id: string;
}

/**
 * Generic keyset-paginated SELECT ordered by `created_at DESC, id DESC` — the convention every
 * table in this schema follows (docs/01 §8: every table carries `created_at`). Callers supply the
 * table/columns/filter; this owns cursor encode/decode and the `LIMIT n+1` over-fetch trick used
 * to detect whether a `nextCursor` should be emitted.
 */
export async function listByCreatedAt<T extends RowWithCursor>(
  db: DbClient,
  opts: ListQueryOptions,
  listParams: ListParams,
): Promise<CursorPage<T>> {
  const limit = resolveLimit(listParams.limit);
  const cursor = listParams.cursor ? decodeCursor(listParams.cursor) : null;

  const clauses: string[] = [];
  const params: unknown[] = [...(opts.params ?? [])];
  if (opts.where) clauses.push(opts.where);
  if (cursor) {
    clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await db.query<T>(
    `SELECT ${opts.columns} FROM ${opts.table} ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, limit + 1],
  );

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;
  return { items, nextCursor };
}
