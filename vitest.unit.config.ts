import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Issue #23: packages/testing/src/** holds scenario/fixture tests (runAllScenarios()-style
      // system scenarios, Postgres-gated integration suites, and multi-package test-DB fixtures),
      // not pure domain-logic unit tests. Excluding the whole directory (Option C — the least
      // brittle: no per-file allowlist to keep in sync as new scenario files are added) keeps
      // `minicoder test unit` scoped to what its own name and docs/04 §12.14 promise. Scenario
      // coverage remains reachable via `minicoder test system` (runAllScenarios(), independent of
      // this Vitest config) and `pnpm test`/CI (root vitest.config.ts, untouched by this file).
      exclude: ['**/*.integration.test.ts', 'packages/testing/src/**', 'node_modules/**'],
    },
  }),
);
