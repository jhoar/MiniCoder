import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { TaskId } from './task-ids.js';
import { ALL_TASK_IDS } from './task-ids.js';
import { TASK_REGISTRY, runRegisteredTask, summarizeResult } from './task-registry.js';
import type { TaskDefinition } from './task-registry.js';
import { createTestDb, insertTestProject } from './test-helpers.js';

describe('TASK_REGISTRY', () => {
  it('has exactly one entry per ALL_TASK_IDS entry, keyed by that same task id', () => {
    expect(TASK_REGISTRY.size).toBe(ALL_TASK_IDS.length);
    for (const taskId of ALL_TASK_IDS) {
      const definition = TASK_REGISTRY.get(taskId);
      expect(definition, `missing task registration for '${taskId}'`).toBeDefined();
      expect(definition!.taskId).toBe(taskId);
      expect(typeof definition!.impl).toBe('function');
      expect(definition!.schema).toBeDefined();
    }
  });

  it('preserves the concurrency limits Trigger.dev configured: 5 for the higher-throughput one-shot tasks, 1 for the rest', () => {
    const highConcurrency: readonly string[] = [
      'ingest-specification',
      'record-clarification-answer',
      'export-plan',
      'export-backlog',
      'run-design-doc',
    ];
    for (const taskId of ALL_TASK_IDS) {
      const expected = highConcurrency.includes(taskId) ? 5 : 1;
      expect(TASK_REGISTRY.get(taskId)!.concurrencyLimit, taskId).toBe(expected);
    }
  });
});

describe('summarizeResult', () => {
  it('redacts secret-shaped substrings and returns valid JSON', () => {
    const summary = summarizeResult({
      reviewed: true,
      note: 'Authorization: Bearer super-secret-value-should-be-redacted',
    });
    const parsed = JSON.parse(summary) as { reviewed: boolean; note: string };
    expect(parsed.reviewed).toBe(true);
    expect(parsed.note).not.toContain('super-secret-value-should-be-redacted');
  });

  it('caps the JSON length at 2000 characters', () => {
    const summary = summarizeResult({ big: 'x'.repeat(5000) });
    expect(summary.length).toBe(2000);
  });
});

describe('runRegisteredTask (issue #122)', () => {
  function fakeDefinition(
    taskId: TaskId,
    impl: (payload: unknown, db: unknown) => Promise<unknown>,
  ): TaskDefinition<unknown, unknown> {
    return {
      taskId,
      concurrencyLimit: 1,
      schema: z.object({ projectId: z.string() }) as unknown as TaskDefinition['schema'],
      impl: impl as TaskDefinition['impl'],
    };
  }

  it('persists the task\'s structured result onto triggerdev_runs.result on success', async () => {
    const db = createTestDb();
    insertTestProject(db);
    const registry = new Map([
      [
        'run-review' as TaskId,
        fakeDefinition('run-review' as TaskId, async () => ({
          reviewed: false,
          decision: 'approved',
        })),
      ],
    ]);

    await runRegisteredTask(
      'run-review' as TaskId,
      { projectId: 'proj-test-001' },
      'run-122-1',
      db,
      registry,
    );

    const rows = await db.query<{ result: string | null }>(
      `SELECT result FROM triggerdev_runs WHERE triggerdev_run_id = ?`,
      ['run-122-1'],
    );
    expect(rows[0]!.result).not.toBeNull();
    expect(JSON.parse(rows[0]!.result!)).toEqual({ reviewed: false, decision: 'approved' });
  });

  it('leaves triggerdev_runs.result NULL on a thrown error', async () => {
    const db = createTestDb();
    insertTestProject(db);
    const registry = new Map([
      [
        'run-review' as TaskId,
        fakeDefinition('run-review' as TaskId, async () => {
          throw new Error('boom');
        }),
      ],
    ]);

    await expect(
      runRegisteredTask(
        'run-review' as TaskId,
        { projectId: 'proj-test-001' },
        'run-122-2',
        db,
        registry,
      ),
    ).rejects.toThrow('boom');

    const rows = await db.query<{ result: string | null; triggerdev_status: string }>(
      `SELECT result, triggerdev_status FROM triggerdev_runs WHERE triggerdev_run_id = ?`,
      ['run-122-2'],
    );
    expect(rows[0]!.triggerdev_status).toBe('failed');
    expect(rows[0]!.result).toBeNull();
  });
});
