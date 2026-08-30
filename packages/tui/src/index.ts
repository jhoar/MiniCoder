/**
 * Root barrel — kept for a "just give me everything" import (issue #60). Every real consumer in
 * this repo (`packages/cli`) now imports from the split `@minicoder/tui/client` (HTTP transport/
 * config) or `@minicoder/tui/views` (Ink presentation) subpaths instead — see CLAUDE.md's Ink Text
 * UI Operational Constraints section for why the split exists and how the two subpaths resolve.
 */
export * from './client/index.js';
export * from './views-entry.js';
