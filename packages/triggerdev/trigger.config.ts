import { defineConfig } from '@trigger.dev/sdk/v3';

// TRIGGER_PROJECT_REF is the project reference ID shown in the Trigger.dev dashboard
// (e.g. "proj_abc123"). A human-readable name is not accepted here.
export default defineConfig({
  project: process.env['TRIGGER_PROJECT_REF'] ?? 'proj_minicoder',
  // dirs expects directories, not individual file paths.
  dirs: ['./src'],
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
