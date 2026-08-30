/**
 * `@minicoder/tui/views` subpath entrypoint (issue #60) — Ink render orchestration and every
 * screen's pure `render*View()` function, no HTTP transport/config. See
 * `packages/tui/views/package.json` (the classic-Node-resolution shim this subpath resolves
 * through, mirroring `packages/tui/client/package.json`'s shape) and CLAUDE.md's Ink Text UI
 * Operational Constraints section for the full rationale.
 */
export { runView } from './render.js';
export * from './views.js';
