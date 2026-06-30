import { z } from 'zod';
import * as fs from 'fs';

export const SystemTestConfigSchema = z.object({
  mode: z.literal('system_test'),
  agents: z.object({
    planner: z.string(),
    coder: z.string(),
    reviewer: z.string(),
    arbiter: z.string(),
    documentation: z.string(),
    human: z.string(),
  }),
  github: z.object({ provider: z.literal('mock') }),
  trigger: z.object({ provider: z.literal('triggerdev-test') }),
  database: z.object({
    reset_on_start: z.boolean(),
    seed_fixture: z.string(),
  }),
});

export type SystemTestConfig = z.infer<typeof SystemTestConfigSchema>;

export const DEFAULT_SYSTEM_TEST_CONFIG: SystemTestConfig = {
  mode: 'system_test',
  agents: {
    planner: 'mock-planner',
    coder: 'mock-coder',
    reviewer: 'mock-reviewer',
    arbiter: 'mock-arbiter',
    documentation: 'mock-documentation',
    human: 'human-test',
  },
  github: { provider: 'mock' },
  trigger: { provider: 'triggerdev-test' },
  database: {
    reset_on_start: true,
    seed_fixture: 'planning-review-merge',
  },
};

export function parseSystemTestConfig(raw: unknown): SystemTestConfig {
  return SystemTestConfigSchema.parse(raw);
}

export function loadSystemTestConfig(filePath: string): SystemTestConfig {
  const content = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      `loadSystemTestConfig: failed to parse JSON at ${filePath}. ` +
        'Only JSON format is supported (not YAML).',
    );
  }
  return parseSystemTestConfig(parsed);
}
