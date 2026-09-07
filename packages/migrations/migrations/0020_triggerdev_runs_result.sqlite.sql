-- Issue #122: runRegisteredTask() discarded every task's structured result once the in-process
-- call returned, leaving `minicoder trigger inspect-run` unable to distinguish "ran and did
-- nothing" (a short-circuit no-op guard) from "did real work" -- both looked identical
-- (status: 'succeeded', error: null). Additive column, JSON-encoded, redacted/length-capped the
-- same way `task_queue.error` already is via `summarizeError()`/`defaultRedactor` -- a task
-- result could in principle carry sensitive fields depending on what a future task returns.
ALTER TABLE triggerdev_runs ADD COLUMN result TEXT;
