import { Command } from 'commander';
import {
  exportWorkflowEventsToOtlp,
  getObservabilityExportCursor,
  setObservabilityExportCursor,
} from '@minicoder/core';
import { createDbClientFromEnv } from '../db-client.js';

/**
 * Issue #67: `exportWorkflowEventsToOtlp()` (Phase 16) is opt-in and fully env-gated, but had no
 * scheduled/automatic caller — CLAUDE.md explicitly required discussing an always-on Trigger.dev
 * task before adding one. The decision: a one-shot CLI command a deployment's own external
 * scheduler (cron, k8s CronJob, etc.) invokes on whatever interval it wants, avoiding a new
 * always-on network dependency entirely. Cursor state (`lastEventId`) is persisted in
 * `observability_export_cursors` so each invocation resumes from the last successful export.
 */
const DEFAULT_CURSOR_ID = 'workflow_events_otlp';

export function createObservabilityCommand(): Command {
  const observability = new Command('observability').description(
    'Optional OpenTelemetry export of workflow events (docs/01 §5.12, issue #67)',
  );

  observability
    .command('export-otel')
    .description(
      'Export workflow_events to the configured OTLP collector (OTEL_EXPORTER_OTLP_ENDPOINT); ' +
        'no-ops if unset. Intended for invocation by an external scheduler (cron, k8s CronJob).',
    )
    .option('--cursor-id <id>', 'Cursor row to track progress under', DEFAULT_CURSOR_ID)
    .option('--limit <n>', 'Max events to export in one invocation')
    .action(async (opts: { cursorId: string; limit?: string }) => {
      const db = await createDbClientFromEnv();
      try {
        const cursor = await getObservabilityExportCursor(db, opts.cursorId);
        const limit = opts.limit ? Number(opts.limit) : undefined;
        // PR #73 review fix (LOW-1): the error message already said "positive integer" — the
        // check only verified finite/positive, so e.g. --limit 1.5 silently passed through.
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
          console.error('Error: --limit must be a positive integer.');
          process.exitCode = 1;
          return;
        }

        const result = await exportWorkflowEventsToOtlp(db, {
          sinceOccurredAt: cursor?.lastOccurredAt,
          sinceEventId: cursor?.lastEventId,
          limit,
        });

        if (result.attempted && result.lastEventId && result.lastOccurredAt) {
          await setObservabilityExportCursor(db, opts.cursorId, {
            lastEventId: result.lastEventId,
            lastOccurredAt: result.lastOccurredAt,
          });
        }

        console.log(
          JSON.stringify(
            {
              command: 'observability export-otel',
              cursorId: opts.cursorId,
              attempted: result.attempted,
              exportedCount: result.exportedCount,
              lastEventId: result.lastEventId,
            },
            null,
            2,
          ),
        );
      } finally {
        await db.close();
      }
    });

  return observability;
}
