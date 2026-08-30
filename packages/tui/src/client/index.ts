/**
 * `@minicoder/tui/client` subpath entrypoint (issue #60) — HTTP transport and client-side
 * configuration only, no Ink/presentation code. See `packages/tui/client/package.json` (the
 * classic-Node-resolution shim this subpath resolves through — this repo's `moduleResolution:
 * "Node"` predates package.json `exports` maps, so a subpath needs a real directory with its own
 * `package.json` pointing at the compiled output, not an `exports` field entry) and CLAUDE.md's
 * Ink Text UI Operational Constraints section for the full rationale.
 */
export {
  ApiClient,
  ApiError,
  type ApiClientOptions,
  type ProblemDetail,
  type WhoamiResponse,
  type ProjectStatus,
  type CommandEnvelopeResponse,
} from './api-client.js';
export { resolveApiConfig, type ApiConfig } from '../config.js';
