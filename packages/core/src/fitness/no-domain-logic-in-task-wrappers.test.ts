import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Architectural fitness test: packages/workflow and packages/triggerdev must not
 * contain domain logic. Workflow Layer tasks are thin wrappers; all business rules
 * live in packages/core.
 *
 * Banned patterns:
 * - Direct imports of state machine validators
 * - Direct state enum comparisons (e.g., FeatureExecutionState.CODING)
 * - Domain entity mutations outside the command interface
 */

const WORKFLOW_SRC = path.resolve(__dirname, '../../../../workflow/src');
const TRIGGERDEV_TASKS_SRC = path.resolve(__dirname, '../../../../triggerdev/src/tasks');
// Trigger.dev replacement: triggerdev-tasks.ts (task({ id, ... }) registration) was deleted and
// replaced by task-registry.ts (the plain TASK_REGISTRY map) + task-worker.ts (the polling
// dispatcher) — both are the same category of thin wrapper this fitness test guards.
const TRIGGERDEV_WRAPPER_SRCS = [
  path.resolve(__dirname, '../../../../triggerdev/src/task-registry.ts'),
  path.resolve(__dirname, '../../../../triggerdev/src/task-worker.ts'),
];

const BANNED_PATTERNS = [
  { pattern: 'StateTransitionValidator', description: 'StateTransitionValidator import' },
  { pattern: 'TransitionError', description: 'TransitionError import' },
  { pattern: 'FeatureExecutionState.', description: 'FeatureExecutionState direct comparison' },
  { pattern: 'PlanState.', description: 'PlanState direct comparison' },
  { pattern: 'ProjectState.', description: 'ProjectState direct comparison' },
];

function collectTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Architectural fitness: packages/workflow has no domain logic', () => {
  const files = collectTsFiles(WORKFLOW_SRC);

  it('workflow src directory is scannable (may be empty before workflow package exists)', () => {
    expect(Array.isArray(files)).toBe(true);
  });

  for (const { pattern, description } of BANNED_PATTERNS) {
    it(`no workflow file uses '${description}'`, () => {
      const violations: string[] = [];
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        if (content.includes(pattern)) {
          violations.push(path.relative(WORKFLOW_SRC, file));
        }
      }
      expect(
        violations,
        `Files with banned pattern '${pattern}': ${violations.join(', ')}`,
      ).toEqual([]);
    });
  }
});

describe('Architectural fitness: packages/triggerdev task files have no domain logic', () => {
  const taskFiles = collectTsFiles(TRIGGERDEV_TASKS_SRC);
  const wrapperFiles = TRIGGERDEV_WRAPPER_SRCS.filter((f) => fs.existsSync(f));
  const files = [...taskFiles, ...wrapperFiles];

  it('triggerdev tasks directory is scannable', () => {
    expect(Array.isArray(files)).toBe(true);
  });

  for (const { pattern, description } of BANNED_PATTERNS) {
    it(`no triggerdev task file uses '${description}'`, () => {
      const violations: string[] = [];
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        if (content.includes(pattern)) {
          violations.push(path.relative(TRIGGERDEV_TASKS_SRC, file));
        }
      }
      expect(
        violations,
        `Files with banned pattern '${pattern}': ${violations.join(', ')}`,
      ).toEqual([]);
    });
  }
});
