import { Command } from 'commander';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FEATURE_EXECUTION_MATRIX } from '@minicoder/core';
import type { FeatureExecutionState } from '@minicoder/core';
import { createDbClientFromEnv } from '../db-client.js';

function isoNow(): string {
  return new Date().toISOString();
}

function ttlIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// Confirmation token TTL: 5 minutes
const CONFIRMATION_TOKEN_TTL_MS = 5 * 60 * 1000;

const REPAIR_PENDING_DIR = path.join(os.homedir(), '.minicoder');
const REPAIR_PENDING_FILE = path.join(REPAIR_PENDING_DIR, 'pending-repair-token.json');

// Orphaned run threshold: 2 hours
const ORPHANED_RUN_THRESHOLD_MS = 2 * 60 * 60 * 1000;
// Triggerdev mismatch threshold: 30 minutes
const TRIGGERDEV_MISMATCH_THRESHOLD_MS = 30 * 60 * 1000;

const KNOWN_FEATURE_STATES = new Set<string>(
  FEATURE_EXECUTION_MATRIX.flatMap((row) => [row.fromState, row.toState]),
);

export function createStateCommand(): Command {
  const state = new Command('state').description('Workflow state lifecycle commands');

  state
    .command('inspect')
    .description('Show current state of a project or feature run')
    .option('--project <id>', 'Project ID')
    .option('--feature-run <id>', 'Feature run ID')
    .action(async (opts: { project?: string; featureRun?: string }) => {
      if (!opts.project && !opts.featureRun) {
        console.error('Error: --project or --feature-run is required');
        process.exit(1);
      }
      const db = await createDbClientFromEnv();
      try {
        let project = null;
        let workflowState = null;
        let activeFeatureRun = null;
        let latestTriggerdevRun = null;
        let unresolvedFindings = null;
        let recentWorkflowEvents = null;
        let pendingOutboxCount = null;

        if (opts.project) {
          const projectRows = await db.query<{
            id: string;
            name: string;
            state: string;
          }>('SELECT id, name, state FROM projects WHERE id = ?', [opts.project]);
          project = projectRows[0] ?? null;

          const wsRows = await db.query<{
            automation_state: string;
            active_feature_run_id: string | null;
          }>(
            'SELECT automation_state, active_feature_run_id FROM workflow_states WHERE project_id = ?',
            [opts.project],
          );
          workflowState = wsRows[0] ?? null;

          if (wsRows[0]?.active_feature_run_id) {
            const runRows = await db.query<{
              id: string;
              current_execution_state: string;
              attempt_no: number;
            }>('SELECT id, current_execution_state, attempt_no FROM feature_runs WHERE id = ?', [
              wsRows[0].active_feature_run_id,
            ]);
            activeFeatureRun = runRows[0] ?? null;
          }
        }

        const featureRunId = opts.featureRun ?? workflowState?.active_feature_run_id ?? null;

        if (featureRunId) {
          const tdRows = await db.query<{
            triggerdev_task_id: string;
            triggerdev_status: string;
            last_seen_at: string;
          }>(
            'SELECT triggerdev_task_id, triggerdev_status, last_seen_at FROM triggerdev_runs WHERE linked_feature_run_id = ? ORDER BY created_at DESC LIMIT 1',
            [featureRunId],
          );
          latestTriggerdevRun = tdRows[0] ?? null;

          if (opts.featureRun) {
            const findingRows = await db.query<{
              id: string;
              severity: string;
              description: string;
            }>(
              `SELECT id, severity, description FROM review_findings
               WHERE feature_run_id = ? AND resolved = 0 AND severity = 'blocking'`,
              [featureRunId],
            );
            unresolvedFindings = findingRows;

            const eventRows = await db.query<{ event_type: string; created_at: string }>(
              'SELECT event_type, created_at FROM workflow_events WHERE project_id = (SELECT project_id FROM feature_requests WHERE id = (SELECT feature_request_id FROM feature_runs WHERE id = ?)) ORDER BY created_at DESC LIMIT 5',
              [featureRunId],
            );
            recentWorkflowEvents = eventRows;

            const outboxRows = await db.query<{ cnt: number }>(
              `SELECT COUNT(*) as cnt FROM outbox_events WHERE status IN ('pending', 'processing')`,
              [],
            );
            pendingOutboxCount = outboxRows[0]?.cnt ?? 0;
          }
        }

        console.log(
          JSON.stringify(
            {
              command: 'state inspect',
              projectId: opts.project ?? null,
              featureRunId: opts.featureRun ?? null,
              project,
              workflowState,
              activeFeatureRun,
              latestTriggerdevRun,
              unresolvedBlockingFindings: unresolvedFindings,
              recentWorkflowEvents,
              pendingOutboxCount,
              timestamp: isoNow(),
            },
            null,
            2,
          ),
        );
      } finally {
        await db.close();
      }
    });

  state
    .command('validate')
    .description('Validates that all active feature run states are known enum values')
    .option('--project <id>', 'Project ID')
    .action(async (opts: { project?: string }) => {
      const db = await createDbClientFromEnv();
      try {
        const whereClause = opts.project
          ? `AND freq.project_id = '${opts.project.replace(/'/g, "''")}'`
          : '';

        const runs = await db.query<{
          id: string;
          current_execution_state: string;
          feature_request_id: string;
        }>(
          `SELECT fr.id, fr.current_execution_state, fr.feature_request_id
           FROM feature_runs fr
           JOIN feature_requests freq ON fr.feature_request_id = freq.id
           WHERE fr.ended_at IS NULL ${whereClause}`,
          [],
        );

        const violations: Array<{ featureRunId: string; state: string; error: string }> = [];
        for (const run of runs) {
          const st = run.current_execution_state as FeatureExecutionState;
          if (!KNOWN_FEATURE_STATES.has(st)) {
            violations.push({
              featureRunId: run.id,
              state: run.current_execution_state,
              error: `Unknown feature execution state: '${st}'`,
            });
          }
        }

        const output = {
          command: 'state validate',
          projectId: opts.project ?? null,
          checkedRuns: runs.length,
          violations,
          valid: violations.length === 0,
          message: violations.length === 0 ? 'No unknown states found' : 'Unknown states detected',
          timestamp: isoNow(),
        };

        console.log(JSON.stringify(output, null, 2));
        if (violations.length > 0) {
          process.exit(1);
        }
      } finally {
        await db.close();
      }
    });

  state
    .command('doctor')
    .description('Detect stale locks, stuck outbox/inbox events, and orphaned runs')
    .option('--project <id>', 'Project ID')
    .action(async (opts: { project?: string }) => {
      const db = await createDbClientFromEnv();
      try {
        const checks = [];
        const orphanedThreshold = agoIso(ORPHANED_RUN_THRESHOLD_MS);
        const triggerdevThreshold = agoIso(TRIGGERDEV_MISMATCH_THRESHOLD_MS);
        const projectFilter = opts.project ? `AND project_id = ?` : '';
        const projectParams = opts.project ? [opts.project] : [];

        // Check: stale_locks
        const staleLocks = await db.query<{ id: string; expires_at: string }>(
          `SELECT id, expires_at FROM workflow_locks WHERE expires_at < CURRENT_TIMESTAMP ${projectFilter}`,
          projectParams,
        );
        checks.push({
          name: 'stale_locks',
          severity: staleLocks.length > 0 ? 'error' : 'ok',
          autoClearable: true,
          count: staleLocks.length,
          details: staleLocks.map((l) => ({ id: l.id, expiresAt: l.expires_at })),
        });

        // Check: stuck_outbox (no project_id on outbox_events table — always global)
        const stuckOutbox = await db.query<{ id: string; event_type: string; attempts: number }>(
          `SELECT id, event_type, attempts FROM outbox_events
           WHERE status IN ('pending', 'processing') AND attempts >= 5`,
          [],
        );
        checks.push({
          name: 'stuck_outbox',
          scope: 'global',
          severity: stuckOutbox.length > 0 ? 'error' : 'ok',
          autoClearable: true,
          count: stuckOutbox.length,
          details: stuckOutbox,
        });

        // Check: stuck_inbox (no project_id on inbox_events table — always global)
        const stuckInbox = await db.query<{ id: string; event_type: string; attempts: number }>(
          `SELECT id, event_type, attempts FROM inbox_events
           WHERE status IN ('pending', 'processing') AND attempts >= 5`,
          [],
        );
        checks.push({
          name: 'stuck_inbox',
          scope: 'global',
          severity: stuckInbox.length > 0 ? 'error' : 'ok',
          autoClearable: true,
          count: stuckInbox.length,
          details: stuckInbox,
        });

        // Check: orphaned_runs (not terminal, not active, started > 2h ago)
        const orphanedProjectFilter = opts.project ? `AND freq.project_id = ?` : '';
        const orphanedParams: unknown[] = [orphanedThreshold];
        if (opts.project) orphanedParams.push(opts.project);

        const orphanedRuns = await db.query<{
          id: string;
          current_execution_state: string;
          started_at: string;
        }>(
          `SELECT fr.id, fr.current_execution_state, fr.started_at
           FROM feature_runs fr
           JOIN feature_requests freq ON fr.feature_request_id = freq.id
           WHERE fr.ended_at IS NULL
             AND fr.current_execution_state NOT IN ('merged', 'human_required', 'blocked', 'failed', 'system_failed', 'ci_failed', 'merge_failed')
             AND fr.id NOT IN (SELECT active_feature_run_id FROM workflow_states WHERE active_feature_run_id IS NOT NULL)
             AND fr.started_at < ?
             ${orphanedProjectFilter}`,
          orphanedParams,
        );
        checks.push({
          name: 'orphaned_runs',
          severity: orphanedRuns.length > 0 ? 'error' : 'ok',
          autoClearable: false,
          manuallyRepairable: true,
          count: orphanedRuns.length,
          details: orphanedRuns,
        });

        // Check: triggerdev_mismatch (triggerdev_runs has no project_id — always global)
        const tdMismatch = await db.query<{
          id: string;
          triggerdev_task_id: string;
          last_seen_at: string;
        }>(
          `SELECT id, triggerdev_task_id, last_seen_at
           FROM triggerdev_runs
           WHERE triggerdev_status = 'running'
             AND last_seen_at < ?`,
          [triggerdevThreshold],
        );
        checks.push({
          name: 'triggerdev_mismatch',
          scope: 'global',
          severity: tdMismatch.length > 0 ? 'warning' : 'ok',
          autoClearable: false,
          count: tdMismatch.length,
          details: tdMismatch,
        });

        const hasErrors = checks.some((c) => c.severity === 'error');
        const output = {
          command: 'state doctor',
          projectId: opts.project ?? null,
          healthy: !hasErrors,
          checks,
          timestamp: isoNow(),
        };

        console.log(JSON.stringify(output, null, 2));
        if (hasErrors) {
          process.exit(1);
        }
      } finally {
        await db.close();
      }
    });

  state
    .command('reconcile')
    .description('Clear auto-clearable anomalies detected by state doctor')
    .option('--project <id>', 'Project ID')
    .option('--all', 'Reconcile all auto-clearable issues')
    .action(async (opts: { project?: string; all?: boolean }) => {
      if (!opts.project && !opts.all) {
        console.error(
          'Error: state reconcile requires --project <id> (project-scoped) or --all (global queues).',
        );
        process.exit(1);
      }
      const db = await createDbClientFromEnv();
      try {
        const cleared = [];
        const projectFilter = opts.project ? `AND project_id = ?` : '';
        const projectParams = opts.project ? [opts.project] : [];

        // Clear stale locks (scoped by project when --project provided)
        const staleLockIds = await db.query<{ id: string }>(
          `SELECT id FROM workflow_locks WHERE expires_at < CURRENT_TIMESTAMP ${projectFilter}`,
          projectParams,
        );
        if (staleLockIds.length > 0) {
          await db.execute(
            `UPDATE workflow_locks SET expires_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE expires_at < CURRENT_TIMESTAMP ${projectFilter}`,
            projectParams,
          );
          cleared.push({ type: 'stale_locks', count: staleLockIds.length });
        }

        // Global queue clearing requires explicit --all (outbox/inbox have no project_id)
        if (opts.all) {
          const stuckOutboxIds = await db.query<{ id: string }>(
            `SELECT id FROM outbox_events WHERE status IN ('pending', 'processing') AND attempts >= 5`,
            [],
          );
          if (stuckOutboxIds.length > 0) {
            await db.execute(
              `UPDATE outbox_events SET status = 'failed', updated_at = CURRENT_TIMESTAMP
               WHERE status IN ('pending', 'processing') AND attempts >= 5`,
              [],
            );
            cleared.push({ type: 'stuck_outbox', scope: 'global', count: stuckOutboxIds.length });
          }

          const stuckInboxIds = await db.query<{ id: string }>(
            `SELECT id FROM inbox_events WHERE status IN ('pending', 'processing') AND attempts >= 5`,
            [],
          );
          if (stuckInboxIds.length > 0) {
            await db.execute(
              `UPDATE inbox_events SET status = 'failed', updated_at = CURRENT_TIMESTAMP
               WHERE status IN ('pending', 'processing') AND attempts >= 5`,
              [],
            );
            cleared.push({ type: 'stuck_inbox', scope: 'global', count: stuckInboxIds.length });
          }
        }

        console.log(
          JSON.stringify(
            {
              command: 'state reconcile',
              projectId: opts.project ?? null,
              cleared,
              timestamp: isoNow(),
            },
            null,
            2,
          ),
        );
      } finally {
        await db.close();
      }
    });

  state
    .command('export-diagnostics')
    .description('Export full state diagnostics as JSON')
    .option('--project <id>', 'Project ID')
    .option('--output <path>', 'Output file path (default: stdout)')
    .action(async (opts: { project?: string; output?: string }) => {
      const db = await createDbClientFromEnv();
      try {
        const projectFilter = opts.project
          ? `WHERE project_id = '${opts.project.replace(/'/g, "''")}'`
          : '';

        const [
          project,
          workflowEvents,
          pendingOutbox,
          pendingInbox,
          triggerdevRuns,
          workflowLocks,
        ] = await Promise.all([
          opts.project
            ? db.query<{ id: string; name: string; state: string }>(
                'SELECT id, name, state FROM projects WHERE id = ?',
                [opts.project],
              )
            : Promise.resolve([]),
          db.query<{ event_type: string; created_at: string; project_id: string }>(
            `SELECT event_type, created_at, project_id FROM workflow_events ${projectFilter} ORDER BY created_at DESC LIMIT 50`,
            [],
          ),
          db.query<{ id: string; event_type: string; status: string; attempts: number }>(
            `SELECT id, event_type, status, attempts FROM outbox_events WHERE status IN ('pending', 'processing') LIMIT 100`,
            [],
          ),
          db.query<{ id: string; event_type: string; status: string; attempts: number }>(
            `SELECT id, event_type, status, attempts FROM inbox_events WHERE status IN ('pending', 'processing') LIMIT 100`,
            [],
          ),
          db.query<{
            id: string;
            triggerdev_task_id: string;
            triggerdev_status: string;
            last_seen_at: string;
          }>(
            `SELECT id, triggerdev_task_id, triggerdev_status, last_seen_at FROM triggerdev_runs WHERE triggerdev_status IN ('running', 'failed') ORDER BY created_at DESC LIMIT 50`,
            [],
          ),
          db.query<{ id: string; expires_at: string }>(
            `SELECT id, expires_at FROM workflow_locks ORDER BY expires_at DESC LIMIT 50`,
            [],
          ),
        ]);

        const diagnostics = JSON.stringify(
          {
            command: 'state export-diagnostics',
            projectId: opts.project ?? null,
            exportedAt: isoNow(),
            project: project[0] ?? null,
            workflowEvents,
            globalOperationalState: {
              scope: 'global',
              pendingOutbox,
              pendingInbox,
              triggerdevRuns,
              workflowLocks,
            },
          },
          null,
          2,
        );

        if (opts.output) {
          fs.writeFileSync(opts.output, diagnostics, 'utf-8');
          console.log(`Diagnostics written to ${opts.output}`);
        } else {
          console.log(diagnostics);
        }
      } finally {
        await db.close();
      }
    });

  state
    .command('repair')
    .description('Apply state repairs (use --dry-run first, then --apply with the issued token)')
    .option('--project <id>', 'Project ID')
    .option('--dry-run', 'Preview repairs and emit a single-use confirmation token')
    .option('--apply', 'Apply repairs (requires --confirmation)')
    .option(
      '--confirmation <token>',
      'Confirmation token issued by --dry-run (time-boxed, single-use)',
    )
    .action(
      async (opts: {
        project?: string;
        dryRun?: boolean;
        apply?: boolean;
        confirmation?: string;
      }) => {
        if (!opts.project) {
          console.error('Error: --project <id> is required for state repair.');
          process.exit(1);
        }
        if (opts.apply && !opts.dryRun) {
          if (!opts.confirmation) {
            console.error('Error: --apply requires --confirmation <token> (run --dry-run first)');
            process.exit(1);
          }
          let pendingToken: { token: string; expiresAt: string; projectId: string };
          try {
            const raw = fs.readFileSync(REPAIR_PENDING_FILE, 'utf-8');
            pendingToken = JSON.parse(raw) as {
              token: string;
              expiresAt: string;
              projectId: string;
            };
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              console.error('Error: no pending repair token found (run --dry-run first)');
            } else {
              console.error('Error: failed to read pending repair token');
            }
            process.exit(1);
          }
          if (opts.confirmation !== pendingToken.token) {
            console.error('Error: confirmation token does not match the issued token');
            process.exit(1);
          }
          if (new Date(pendingToken.expiresAt) <= new Date()) {
            console.error(
              'Error: confirmation token has expired. Run --dry-run again to get a new token.',
            );
            process.exit(1);
          }
          if (opts.project !== pendingToken.projectId) {
            console.error(
              `Error: token was issued for project "${pendingToken.projectId}" but --project is "${opts.project}"`,
            );
            process.exit(1);
          }

          const db = await createDbClientFromEnv();
          try {
            const repairs: Array<{ type: string; description: string }> = [];
            const orphanedThreshold = agoIso(ORPHANED_RUN_THRESHOLD_MS);

            // opts.project is guaranteed non-null (guarded at top of action)
            const orphanedParams: unknown[] = [orphanedThreshold, opts.project];

            // Wrap mutations + event INSERT in a single transaction
            await db.transaction(async (tx) => {
              const orphanedRuns = await tx.query<{ id: string }>(
                `SELECT fr.id FROM feature_runs fr
                 JOIN feature_requests freq ON fr.feature_request_id = freq.id
                 WHERE fr.ended_at IS NULL
                   AND fr.current_execution_state NOT IN ('merged', 'human_required', 'blocked', 'failed', 'system_failed', 'ci_failed', 'merge_failed')
                   AND fr.id NOT IN (SELECT active_feature_run_id FROM workflow_states WHERE active_feature_run_id IS NOT NULL)
                   AND fr.started_at < ?
                   AND freq.project_id = ?`,
                orphanedParams,
              );

              for (const run of orphanedRuns) {
                await tx.execute(
                  `UPDATE feature_runs SET current_execution_state = 'human_required', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?`,
                  [run.id],
                );
                repairs.push({
                  type: 'orphaned_run',
                  description: `feature_run ${run.id} marked human_required`,
                });
              }

              if (repairs.length > 0) {
                await tx.execute(
                  `INSERT INTO workflow_events (id, project_id, event_type, from_state, to_state, actor, payload, payload_schema_version, occurred_at, created_at)
                   VALUES (?, ?, 'state.repaired', NULL, NULL, 'operator', ?, '1.0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                  [
                    crypto.randomUUID(),
                    opts.project,
                    JSON.stringify({ repairs, appliedAt: isoNow() }),
                  ],
                );
              }
            });

            // Token is single-use: delete AFTER the transaction commits successfully
            fs.unlinkSync(REPAIR_PENDING_FILE);

            console.log(
              JSON.stringify(
                {
                  command: 'state repair --apply',
                  projectId: opts.project,
                  repairs,
                  timestamp: isoNow(),
                },
                null,
                2,
              ),
            );
          } finally {
            await db.close();
          }
          return;
        }

        // --dry-run (default behavior): emit file-based confirmation token
        const token = crypto.randomUUID();
        const expiresAt = ttlIso(CONFIRMATION_TOKEN_TTL_MS);
        fs.mkdirSync(REPAIR_PENDING_DIR, { recursive: true });
        fs.writeFileSync(
          REPAIR_PENDING_FILE,
          JSON.stringify({ token, expiresAt, projectId: opts.project ?? null }),
          { encoding: 'utf-8', mode: 0o600 },
        );

        console.log(
          JSON.stringify(
            {
              command: 'state repair --dry-run',
              projectId: opts.project ?? null,
              previewChanges: ['mark_orphaned_runs_as_human_required'],
              confirmationToken: token,
              tokenExpiresAt: expiresAt,
              note: 'To apply: minicoder state repair --apply --confirmation <token>',
              timestamp: isoNow(),
            },
            null,
            2,
          ),
        );
      },
    );

  return state;
}
