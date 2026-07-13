import { describe, it, expect } from 'vitest';
import { ALL_TASK_IDS } from './task-ids.js';
import { TASK_REGISTRY } from './task-registry.js';

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
