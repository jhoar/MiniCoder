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
      '@minicoder/gitea': path.resolve(__dirname, 'packages/gitea/src/index.ts'),
      '@minicoder/gitlab': path.resolve(__dirname, 'packages/gitlab/src/index.ts'),
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
      '@minicoder/adapters-documentation': path.resolve(
        __dirname,
        'packages/adapters-documentation/src/index.ts',
      ),
      '@minicoder/triggerdev': path.resolve(__dirname, 'packages/triggerdev/src/index.ts'),
      '@minicoder/testing': path.resolve(__dirname, 'packages/testing/src/index.ts'),
      '@minicoder/api': path.resolve(__dirname, 'packages/api/src/index.ts'),
      // Issue #60: `@minicoder/tui`'s split subpaths resolve through a classic-Node-resolution
      // shim (`packages/tui/{client,views}/package.json`) pointing at compiled `dist/` output —
      // aliased directly to source here too, so `pnpm test` never depends on `packages/tui` having
      // been built first. The bare `@minicoder/tui` key below is `$`-anchored (exact-match only) —
      // without it, `@rollup/plugin-alias`'s default prefix matching lets the shorter
      // `@minicoder/tui` entry swallow `@minicoder/tui/client`/`.../views` too (rewriting them to
      // a nonsensical `<...>/src/index.ts/client` path), since object-key aliases match by string
      // prefix, not by exact equality, unless anchored — confirmed empirically: without `$`, both
      // subpath imports failed with "Cannot find module" even with the correct replacement path.
      '@minicoder/tui$': path.resolve(__dirname, 'packages/tui/src/index.ts'),
      '@minicoder/tui/client': path.resolve(__dirname, 'packages/tui/src/client/index.ts'),
      '@minicoder/tui/views': path.resolve(__dirname, 'packages/tui/src/views-entry.ts'),
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
