import { defineConfig } from '@trigger.dev/sdk/v3';

// TRIGGER_PROJECT_REF must be set to the project reference ID shown in the Trigger.dev
// dashboard (e.g. "proj_abc123"). A human-readable name is not accepted. Fail fast
// rather than silently deploying to a wrong or default project.
const projectRef = process.env['TRIGGER_PROJECT_REF'];
if (!projectRef) {
  throw new Error(
    'TRIGGER_PROJECT_REF is not set. ' +
      'Provide your Trigger.dev project reference ID (e.g. proj_abc123) ' +
      'as an environment variable before deploying.',
  );
}

export default defineConfig({
  project: projectRef,
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
