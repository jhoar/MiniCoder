import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteDbClient } from '@minicoder/persistence-sqlite';
import { InboxProcessor } from './processor.js';
import type { InboxHandler } from './processor.js';
import { createTestDb, insertTestProject } from '../test-helpers.js';

let db: SqliteDbClient;
let raw: Database.Database;

beforeEach(() => {
  db = createTestDb();
  raw = (db as unknown as { db: Database.Database }).db;
  insertTestProject(raw);
});

function insertInboxEvent(
  id: string,
  eventType = 'feature.selected',
  status = 'pending',
  attempts = 0,
  payload = '{"featureRunId":"00000000-0000-0000-0000-000000000001","projectId":"00000000-0000-0000-0000-000000000002","fromState":"approved_pending_execution","toState":"selected"}',
): void {
  raw
    .prepare(
      `INSERT INTO inbox_events (id, dedup_key, event_type, payload, payload_schema_version, status, attempts, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, '1.0.0', ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .run(id, id, eventType, payload, status, attempts);
}

describe('InboxProcessor', () => {
  it('processes a pending event and marks it processed', async () => {
    insertInboxEvent('evt-1');
    const handleFn = vi.fn().mockResolvedValue(undefined);
    const handler: InboxHandler = { eventType: 'feature.selected', handle: handleFn };
    const processor = new InboxProcessor(db, new Map([['feature.selected', handler]]));

    const result = await processor.pollAndProcess();
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(handleFn).toHaveBeenCalledOnce();

    const row = raw.prepare('SELECT status FROM inbox_events WHERE id = ?').get('evt-1') as {
      status: string;
    };
    expect(row.status).toBe('processed');
  });

  it('increments attempts and sets next_retry_at on handler failure', async () => {
    insertInboxEvent('evt-2');
    const handler: InboxHandler = {
      eventType: 'feature.selected',
      handle: vi.fn().mockRejectedValue(new Error('handler error')),
    };
    const processor = new InboxProcessor(db, new Map([['feature.selected', handler]]), {
      baseBackoffMs: 1000,
    });

    const result = await processor.pollAndProcess();
    expect(result.failed).toBe(1);

    const row = raw
      .prepare('SELECT status, attempts, next_retry_at FROM inbox_events WHERE id = ?')
      .get('evt-2') as { status: string; attempts: number; next_retry_at: string };
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.next_retry_at).toBeTruthy();
  });

  it('requeues events with no registered handler for later retry', async () => {
    insertInboxEvent('evt-3', 'unknown.event', 'pending', 0, '{"test":true}');
    const processor = new InboxProcessor(db, new Map());

    const result = await processor.pollAndProcess();
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);

    const row = raw.prepare('SELECT status FROM inbox_events WHERE id = ?').get('evt-3') as {
      status: string;
    };
    expect(row.status).toBe('pending');
  });

  it('does not re-process events that have reached maxAttempts', async () => {
    insertInboxEvent('evt-4', 'feature.selected', 'failed', 5);
    const handleFn = vi.fn().mockResolvedValue(undefined);
    const processor = new InboxProcessor(
      db,
      new Map([['feature.selected', { eventType: 'feature.selected', handle: handleFn }]]),
      { maxAttempts: 5 },
    );

    await processor.pollAndProcess();
    expect(handleFn).not.toHaveBeenCalled();
  });

  it('known events are processed even when unknown events outnumber the batch size', async () => {
    // 3 unknown events before the known event; batchSize=2 so without prioritisation
    // the known event would never be picked up.
    insertInboxEvent('evt-u1', 'unknown.event', 'pending', 0, '{"test":true}');
    insertInboxEvent('evt-u2', 'unknown.event', 'pending', 0, '{"test":true}');
    insertInboxEvent('evt-u3', 'unknown.event', 'pending', 0, '{"test":true}');
    insertInboxEvent('evt-k1');
    const handleFn = vi.fn().mockResolvedValue(undefined);
    const processor = new InboxProcessor(
      db,
      new Map([['feature.selected', { eventType: 'feature.selected', handle: handleFn }]]),
      { maxBackoffMs: 60_000, batchSize: 2 },
    );

    const result = await processor.pollAndProcess();
    // Known event always processed first
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(handleFn).toHaveBeenCalledOnce();

    // Unknown events must NOT have been processed (attempts still 0, pushed back by maxBackoffMs)
    const u1 = raw
      .prepare(`SELECT attempts, next_retry_at FROM inbox_events WHERE id = 'evt-u1'`)
      .get() as { attempts: number; next_retry_at: string };
    expect(u1.attempts).toBe(0);
    expect(u1.next_retry_at).toBeTruthy();

    // A second immediate poll finds nothing eligible
    const result2 = await processor.pollAndProcess();
    expect(result2.processed).toBe(0);
  });

  it('fails the event when payload schema validation fails', async () => {
    // Insert invalid payload for feature.selected (missing required fields)
    insertInboxEvent('evt-5', 'feature.selected', 'pending', 0, '{"bad":"payload"}');
    const handleFn = vi.fn().mockResolvedValue(undefined);
    const processor = new InboxProcessor(
      db,
      new Map([['feature.selected', { eventType: 'feature.selected', handle: handleFn }]]),
    );

    const result = await processor.pollAndProcess();
    expect(result.failed).toBe(1);
    expect(result.processed).toBe(0);
    // Handler must not be called with an invalid payload
    expect(handleFn).not.toHaveBeenCalled();
  });
});
