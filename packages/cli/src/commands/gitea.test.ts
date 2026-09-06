import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';

interface InboxEventRow {
  id: string;
  dedup_key: string;
  event_type: string;
}

class FakeDb {
  events: InboxEventRow[] = [];
  close = vi.fn(async () => {});

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (sql.startsWith('INSERT INTO inbox_events')) {
      const [id, dedupKey, eventType] = params as [string, string, string];
      if (this.events.some((e) => e.dedup_key === dedupKey)) {
        const err = new Error(`UNIQUE constraint failed: inbox_events.dedup_key`) as Error & {
          code: string;
        };
        err.code = 'SQLITE_CONSTRAINT_UNIQUE';
        throw err;
      }
      this.events.push({ id, dedup_key: dedupKey, event_type: eventType });
      return;
    }
    throw new Error(`FakeDb.execute: unhandled SQL: ${sql}`);
  }
}

let fakeDb: FakeDb;
const createDbClientFromEnvMock = vi.fn(async () => fakeDb);
vi.mock('../db-client.js', () => ({
  createDbClientFromEnv: () => createDbClientFromEnvMock(),
}));

async function loadCommand() {
  const { createGiteaCommand } = await import('./gitea.js');
  return createGiteaCommand();
}

function makeProgram(command: Command): Command {
  const program = new Command().exitOverride();
  program.addCommand(command);
  return program;
}

describe('CLI gitea simulate-* commands', () => {
  const originalAppEnv = process.env['APP_ENV'];

  beforeEach(() => {
    fakeDb = new FakeDb();
    vi.clearAllMocks();
    process.env['APP_ENV'] = 'development';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    if (originalAppEnv === undefined) delete process.env['APP_ENV'];
    else process.env['APP_ENV'] = originalAppEnv;
  });

  it('issue #113: a repeated simulate-check-passed call for the same PR/check-name no longer crashes', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync([
      'node',
      'minicoder',
      'gitea',
      'simulate-check-passed',
      '--project',
      'ons',
      '--pr-number',
      '1',
    ]);
    await program.parseAsync([
      'node',
      'minicoder',
      'gitea',
      'simulate-check-passed',
      '--project',
      'ons',
      '--pr-number',
      '1',
    ]);

    expect(fakeDb.events).toHaveLength(2);
    // Both share the same "logical" dedup key prefix but are distinct rows.
    expect(fakeDb.events[0]?.dedup_key).not.toBe(fakeDb.events[1]?.dedup_key);
    expect(logSpy.mock.calls.filter((c) => c.join(' ').includes('check.passed'))).toHaveLength(2);
  });

  it('a genuine same-key collision (forced) surfaces a clean error, not a raw SqliteError', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    // Force a collision by pre-seeding the exact dedup_key this invocation would produce.
    const originalExecute = fakeDb.execute.bind(fakeDb);
    let call = 0;
    fakeDb.execute = async (sql: string, params: unknown[] = []) => {
      call += 1;
      if (call === 1) {
        // Seed a row whose dedup_key collides with whatever this call is about to insert.
        const dedupKey = (params as [string, string])[1];
        fakeDb.events.push({ id: 'seed', dedup_key: dedupKey, event_type: 'check.passed' });
      }
      return originalExecute(sql, params);
    };

    await expect(
      program.parseAsync([
        'node',
        'minicoder',
        'gitea',
        'simulate-check-passed',
        '--project',
        'ons',
        '--pr-number',
        '1',
      ]),
    ).rejects.toThrow(/already queued this same millisecond/);
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('SQLITE_CONSTRAINT'));
  });
});
