import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteDbClient } from '@minicoder/persistence-sqlite';
import { IdempotencySweeper } from './idempotency-sweeper.js';
import { createTestDb } from '../test-helpers.js';

let db: SqliteDbClient;
let raw: Database.Database;

beforeEach(() => {
  db = createTestDb();
  raw = (db as unknown as { db: Database.Database }).db;
});

function insertKey(id: string, expiresAt: string): void {
  raw.prepare(
    `INSERT INTO idempotency_keys (id, key, scope, result, expires_at, version, created_at, updated_at)
     VALUES (?, ?, 'test', '{}', ?, 1, datetime('now'), datetime('now'))`,
  ).run(id, id, expiresAt);
}

describe('IdempotencySweeper', () => {
  it('removes expired keys and leaves non-expired ones', async () => {
    insertKey('expired-1', new Date(Date.now() - 1000).toISOString());
    insertKey('expired-2', new Date(Date.now() - 5000).toISOString());
    insertKey('live-1', new Date(Date.now() + 60_000).toISOString());

    const sweeper = new IdempotencySweeper(db);
    const result = await sweeper.sweep();

    expect(result.removed).toBe(2);
    const remaining = raw.prepare('SELECT id FROM idempotency_keys').all() as Array<{ id: string }>;
    expect(remaining.map((r) => r.id)).toEqual(['live-1']);
  });

  it('returns 0 when nothing is expired', async () => {
    insertKey('live-2', new Date(Date.now() + 60_000).toISOString());
    const sweeper = new IdempotencySweeper(db);
    const result = await sweeper.sweep();
    expect(result.removed).toBe(0);
  });
});
