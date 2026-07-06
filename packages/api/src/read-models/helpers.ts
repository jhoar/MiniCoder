import type { DbClient } from '@minicoder/core';
import { NotFoundError } from '../errors.js';

/** Fetch a single row by primary key, throwing `NotFoundError` (mapped to a 404) if absent. */
export async function getByIdOrThrow<T>(
  db: DbClient,
  table: string,
  columns: string,
  id: string,
  resourceName: string = table,
): Promise<T> {
  const rows = await db.query<T>(`SELECT ${columns} FROM ${table} WHERE id = ?`, [id]);
  const row = rows[0];
  if (!row) throw new NotFoundError(resourceName, id);
  return row;
}

export async function getByIdOrNull<T>(
  db: DbClient,
  table: string,
  columns: string,
  id: string,
): Promise<T | null> {
  const rows = await db.query<T>(`SELECT ${columns} FROM ${table} WHERE id = ?`, [id]);
  return rows[0] ?? null;
}
