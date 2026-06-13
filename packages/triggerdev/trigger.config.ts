import { defineConfig } from '@trigger.dev/sdk/v3';

export default defineConfig({
  project: 'minicoder',
  dirs: ['./src/triggerdev-tasks.ts'],
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 30_000,
    },
  },
});
