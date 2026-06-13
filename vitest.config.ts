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
      '@minicoder/triggerdev': path.resolve(__dirname, 'packages/triggerdev/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.d.ts'],
    },
  },
});
