import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteDbClient } from '@minicoder/persistence-sqlite';
import { OutboxDispatcher } from './dispatcher.js';
import type { OutboxHandler } from './dispatcher.js';
import { deterministicBackoff } from './backoff.js';
import { createTestDb, insertTestProject } from '../test-helpers.js';

let db: SqliteDbClient;
let raw: Database.Database;

beforeEach(() => {
  db = createTestDb();
  raw = (db as unknown as { db: Database.Database }).db;
  insertTestProject(raw);
});

function insertOutboxEvent(
  id: string,
  eventType = 'feature.selected',
  status = 'pending',
  attempts = 0,
): void {
  raw
    .prepare(
      `INSERT INTO outbox_events (id, event_type, payload, payload_schema_version, status, attempts, version, created_at, updated_at)
     VALUES (?, ?, '{"test":true}', '1.0.0', ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .run(id, eventType, status, attempts);
}

describe('deterministicBackoff', () => {
  it('returns 0 for attempt 0', () => {
    expect(deterministicBackoff(0, 1000, 60_000)).toBe(0);
  });
  it('returns baseMs for attempt 1', () => {
    expect(deterministicBackoff(1, 1000, 60_000)).toBe(1000);
  });
  it('doubles per attempt', () => {
    expect(deterministicBackoff(2, 1000, 60_000)).toBe(2000);
    expect(deterministicBackoff(3, 1000, 60_000)).toBe(4000);
  });
  it('caps at maxMs', () => {
    expect(deterministicBackoff(10, 1000, 60_000)).toBe(60_000);
  });
});

describe('OutboxDispatcher', () => {
  it('dispatches a pending event and marks it delivered', async () => {
    insertOutboxEvent('evt-1');
    const handleFn = vi.fn().mockResolvedValue(undefined);
    const handler: OutboxHandler = { eventType: 'feature.selected', handle: handleFn };
    const dispatcher = new OutboxDispatcher(db, new Map([['feature.selected', handler]]));

    const result = await dispatcher.pollAndDispatch();
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
    expect(handleFn).toHaveBeenCalledOnce();

    const row = raw.prepare('SELECT status FROM outbox_events WHERE id = ?').get('evt-1') as {
      status: string;
    };
    expect(row.status).toBe('delivered');
  });

  it('increments attempts and sets next_retry_at on handler failure', async () => {
    insertOutboxEvent('evt-2');
    const handler: OutboxHandler = {
      eventType: 'feature.selected',
      handle: vi.fn().mockRejectedValue(new Error('handler error')),
    };
    const dispatcher = new OutboxDispatcher(db, new Map([['feature.selected', handler]]), {
      baseBackoffMs: 1000,
    });

    const result = await dispatcher.pollAndDispatch();
    expect(result.failed).toBe(1);

    const row = raw
      .prepare('SELECT status, attempts, next_retry_at FROM outbox_events WHERE id = ?')
      .get('evt-2') as { status: string; attempts: number; next_retry_at: string };
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.next_retry_at).toBeTruthy();
  });

  it('requeues events with no registered handler for later retry', async () => {
    insertOutboxEvent('evt-3', 'unknown.event');
    const dispatcher = new OutboxDispatcher(db, new Map());

    const result = await dispatcher.pollAndDispatch();
    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(0);

    // Event must not be permanently skipped — it stays 'pending' for retry once
    // a handler is registered.
    const row = raw.prepare('SELECT status FROM outbox_events WHERE id = ?').get('evt-3') as {
      status: string;
    };
    expect(row.status).toBe('pending');
  });

  it('does not re-dispatch events that have reached maxAttempts', async () => {
    insertOutboxEvent('evt-4', 'feature.selected', 'failed', 5);
    const handleFn = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new OutboxDispatcher(
      db,
      new Map([['feature.selected', { eventType: 'feature.selected', handle: handleFn }]]),
      { maxAttempts: 5 },
    );

    await dispatcher.pollAndDispatch();
    expect(handleFn).not.toHaveBeenCalled();
  });

  it('stale-claim recovery resets stuck processing rows so they are re-dispatched', async () => {
    // Row stuck in 'processing' longer than staleClaimMs — simulates a crashed worker
    raw
      .prepare(
        `INSERT INTO outbox_events (id, event_type, payload, payload_schema_version, status, attempts, version, created_at, updated_at)
         VALUES ('evt-5', 'feature.selected', '{"test":true}', '1.0.0', 'processing', 0, 2,
                 datetime('now', '-10 minutes'), datetime('now', '-10 minutes'))`,
      )
      .run();

    const handleFn = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new OutboxDispatcher(
      db,
      new Map([['feature.selected', { eventType: 'feature.selected', handle: handleFn }]]),
      { staleClaimMs: 5 * 60 * 1000 }, // 5 min — row was stuck for 10 min
    );

    const result = await dispatcher.pollAndDispatch();
    // Stale recovery reset it to pending; same poll then dispatched it
    expect(result.dispatched).toBe(1);
    expect(handleFn).toHaveBeenCalledOnce();

    const row = raw.prepare(`SELECT status FROM outbox_events WHERE id = 'evt-5'`).get() as { status: string };
    expect(row.status).toBe('delivered');
  });

  it('unknown events use maxBackoffMs and do not starve known events', async () => {
    // Insert 2 unknown events and 1 known event — batchSize=3 so all three enter the batch
    insertOutboxEvent('evt-u1', 'unknown.event');
    insertOutboxEvent('evt-u2', 'unknown.event');
    insertOutboxEvent('evt-k1', 'feature.selected');
    const handleFn = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new OutboxDispatcher(
      db,
      new Map([['feature.selected', { eventType: 'feature.selected', handle: handleFn }]]),
      { maxBackoffMs: 60_000, batchSize: 3 },
    );

    const result = await dispatcher.pollAndDispatch();
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
    expect(handleFn).toHaveBeenCalledOnce();

    // Unknown events must be pushed back by maxBackoffMs, not baseBackoffMs
    const before = new Date(Date.now() + 59_000).toISOString();
    const u1 = raw.prepare(`SELECT next_retry_at FROM outbox_events WHERE id = 'evt-u1'`).get() as { next_retry_at: string };
    expect(u1.next_retry_at > before).toBe(true);

    // On a second poll (within the retry window) only zero events are eligible
    const result2 = await dispatcher.pollAndDispatch();
    expect(result2.dispatched).toBe(0);
  });
});
