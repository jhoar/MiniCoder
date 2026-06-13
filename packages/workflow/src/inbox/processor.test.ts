import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

afterEach(() => {
  vi.restoreAllMocks();
  raw.close();
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
    // 3 unknown events before the known event; batchSize=4 so all 3 unknowns fit in
    // the second pass (remaining=3 after 1 known), making the second poll truly empty.
    insertInboxEvent('evt-u1', 'unknown.event', 'pending', 0, '{"test":true}');
    insertInboxEvent('evt-u2', 'unknown.event', 'pending', 0, '{"test":true}');
    insertInboxEvent('evt-u3', 'unknown.event', 'pending', 0, '{"test":true}');
    insertInboxEvent('evt-k1');
    const handleFn = vi.fn().mockResolvedValue(undefined);
    const processor = new InboxProcessor(
      db,
      new Map([['feature.selected', { eventType: 'feature.selected', handle: handleFn }]]),
      { maxBackoffMs: 60_000, batchSize: 4 },
    );

    const result = await processor.pollAndProcess();
    // Known event always processed first
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(handleFn).toHaveBeenCalledOnce();

    // All 3 unknown events must have been requeued (attempts still 0, pushed back by maxBackoffMs)
    for (const id of ['evt-u1', 'evt-u2', 'evt-u3']) {
      const row = raw
        .prepare(`SELECT attempts, next_retry_at FROM inbox_events WHERE id = ?`)
        .get(id) as { attempts: number; next_retry_at: string };
      expect(row.attempts).toBe(0);
      expect(row.next_retry_at).toBeTruthy();
    }

    // A second immediate poll finds nothing eligible: all unknowns are within their backoff window
    const result2 = await processor.pollAndProcess();
    expect(result2.processed).toBe(0);
  });

  it('pollAndProcess completes promptly after a long-running handler (heartbeat regression)', async () => {
    insertInboxEvent('evt-long');
    let handlerCompleted = false;
    const handleFn = vi.fn().mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      handlerCompleted = true;
    });
    const processor = new InboxProcessor(
      db,
      new Map([['feature.selected', { eventType: 'feature.selected', handle: handleFn }]]),
      { staleClaimMs: 100 }, // heartbeatMs = 50ms; fires multiple times before handler finishes
    );

    const result = await processor.pollAndProcess();
    expect(handlerCompleted).toBe(true);
    expect(result.processed).toBe(1);

    const row = raw.prepare(`SELECT status FROM inbox_events WHERE id = 'evt-long'`).get() as {
      status: string;
    };
    expect(row.status).toBe('processed');
  }, 2_000);

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

  it('does not count processing when heartbeat detects ownership loss (reclaim regression)', async () => {
    insertInboxEvent('evt-lost');
    const original = db.executeAffected.bind(db);
    vi.spyOn(db, 'executeAffected').mockImplementation(async (sql, params) => {
      // Heartbeat UPDATE: SET updated_at WHERE status = 'processing' AND version = ?
      if (/SET updated_at.*status = 'processing'/s.test(sql)) {
        return 0; // Simulate row reclaimed by stale-claim recovery
      }
      return original(sql, params as unknown[]);
    });

    let handlerRan = false;
    const handleFn = vi.fn().mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      handlerRan = true;
    });
    const processor = new InboxProcessor(
      db,
      new Map([['feature.selected', { eventType: 'feature.selected', handle: handleFn }]]),
      { staleClaimMs: 100 }, // heartbeatMs = 50ms — fires before handler completes
    );

    const result = await processor.pollAndProcess();

    expect(handlerRan).toBe(true); // handler still runs to completion
    expect(result.processed).toBe(0); // NOT counted — ownership was lost
    expect(result.failed).toBe(0);

    // markProcessed must NOT have been called — row stays in 'processing'
    const row = raw.prepare(`SELECT status FROM inbox_events WHERE id = 'evt-lost'`).get() as {
      status: string;
    };
    expect(row.status).toBe('processing');
  }, 2_000);

  it('does not count processing when heartbeat DB error sets lostOwnership (DB-error regression)', async () => {
    insertInboxEvent('evt-dberr');
    const original = db.executeAffected.bind(db);
    vi.spyOn(db, 'executeAffected').mockImplementation(async (sql, params) => {
      if (/SET updated_at.*status = 'processing'/s.test(sql)) {
        throw new Error('simulated DB connection error');
      }
      return original(sql, params as unknown[]);
    });

    let handlerRan = false;
    const handleFn = vi.fn().mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      handlerRan = true;
    });
    const processor = new InboxProcessor(
      db,
      new Map([['feature.selected', { eventType: 'feature.selected', handle: handleFn }]]),
      { staleClaimMs: 100 },
    );

    const result = await processor.pollAndProcess();

    expect(handlerRan).toBe(true);
    expect(result.processed).toBe(0); // DB error → lostOwnership → not counted
    expect(result.failed).toBe(0);

    const row = raw.prepare(`SELECT status FROM inbox_events WHERE id = 'evt-dberr'`).get() as {
      status: string;
    };
    expect(row.status).toBe('processing'); // markProcessed skipped
  }, 2_000);

  it('throws when constructed with invalid staleClaimMs', () => {
    const msg = 'staleClaimMs must be a finite integer >= 2';
    expect(() => new InboxProcessor(db, new Map(), { staleClaimMs: 0 })).toThrow(msg);
    expect(() => new InboxProcessor(db, new Map(), { staleClaimMs: 1 })).toThrow(msg);
    expect(() => new InboxProcessor(db, new Map(), { staleClaimMs: NaN })).toThrow(msg);
    expect(() => new InboxProcessor(db, new Map(), { staleClaimMs: Infinity })).toThrow(msg);
    expect(() => new InboxProcessor(db, new Map(), { staleClaimMs: 100.5 })).toThrow(msg);
  });

  it('fails the event when payload_schema_version does not match SCHEMA_VERSION', async () => {
    // Insert an event with a stale schema version — even with a valid payload shape
    raw
      .prepare(
        `INSERT INTO inbox_events (id, dedup_key, event_type, payload, payload_schema_version, status, attempts, version, created_at, updated_at)
         VALUES ('evt-6', 'evt-6', 'feature.selected', '{"featureRunId":"00000000-0000-0000-0000-000000000001","projectId":"00000000-0000-0000-0000-000000000002","fromState":"approved_pending_execution","toState":"selected"}', '0.9.0', 'pending', 0, 1, datetime('now'), datetime('now'))`,
      )
      .run();
    const handleFn = vi.fn().mockResolvedValue(undefined);
    const processor = new InboxProcessor(
      db,
      new Map([['feature.selected', { eventType: 'feature.selected', handle: handleFn }]]),
    );

    const result = await processor.pollAndProcess();
    expect(result.failed).toBe(1);
    expect(result.processed).toBe(0);
    expect(handleFn).not.toHaveBeenCalled();

    const row = raw.prepare('SELECT status FROM inbox_events WHERE id = ?').get('evt-6') as {
      status: string;
    };
    expect(row.status).toBe('failed');
  });
});
