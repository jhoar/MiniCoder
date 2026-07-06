import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@minicoder/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@minicoder/persistence-sqlite': path.resolve(
        __dirname,
        'packages/persistence-sqlite/src/index.ts',
      ),
      '@minicoder/persistence-postgres': path.resolve(
        __dirname,
        'packages/persistence-postgres/src/index.ts',
      ),
      '@minicoder/migrations': path.resolve(__dirname, 'packages/migrations/src/index.ts'),
      '@minicoder/workflow': path.resolve(__dirname, 'packages/workflow/src/index.ts'),
      '@minicoder/github': path.resolve(__dirname, 'packages/github/src/index.ts'),
      '@minicoder/adapters-reviewer': path.resolve(
        __dirname,
        'packages/adapters-reviewer/src/index.ts',
      ),
      '@minicoder/adapters-coder': path.resolve(__dirname, 'packages/adapters-coder/src/index.ts'),
      '@minicoder/adapters-planner': path.resolve(
        __dirname,
        'packages/adapters-planner/src/index.ts',
      ),
      '@minicoder/adapters-arbiter': path.resolve(
        __dirname,
        'packages/adapters-arbiter/src/index.ts',
      ),
      '@minicoder/triggerdev': path.resolve(__dirname, 'packages/triggerdev/src/index.ts'),
      '@minicoder/testing': path.resolve(__dirname, 'packages/testing/src/index.ts'),
      '@minicoder/api': path.resolve(__dirname, 'packages/api/src/index.ts'),
      '@minicoder/tui': path.resolve(__dirname, 'packages/tui/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.d.ts'],
    },
  },
});
