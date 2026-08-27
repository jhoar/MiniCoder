import { Command } from 'commander';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  validateFeatureRunStates,
  runDoctorChecks,
  checkPrDiscoveryDivergence,
  reconcileState,
  exportDiagnostics,
} from '@minicoder/api';
import { requireNonBlankEnvVar } from '@minicoder/triggerdev';
import type { ScmClient } from '@minicoder/core';
import { createDbClientFromEnv } from '../db-client.js';

/**
 * Issue #35 (generalized in docs/06 §Phase 18 Stage 5): `--check-scm` is opt-in specifically
 * because — unlike every other `state doctor` check — it needs a live SCM-provider credential,
 * mirroring `github-reconciliation.ts`'s/`merge.ts`'s `resolveDefaultGithubClientFactory`/
 * `resolveGithubClient` pattern (a provider credential is a single deployment-wide secret per
 * provider, not a per-call injected dependency). Resolves the concrete `ScmClient` implementation
 * from the candidate repository's own `provider`/`base_url` columns rather than always
 * constructing `OctokitGitHubClient` — a deployment whose projects span more than one provider
 * needs the right client (and the right credential) per candidate, not just for GitHub.
 * `--check-github` remains a supported, undocumented alias for `--check-scm` (see the `doctor`
 * command below) purely for backward compatibility with existing scripts/runbooks.
 */
async function resolveScmClientForDoctor(
  provider: string,
  baseUrl: string | null,
): Promise<ScmClient> {
  switch (provider) {
    case 'github': {
      const token = requireNonBlankEnvVar(
        'GITHUB_TOKEN',
        'state doctor --check-scm requires a GitHub credential (GitHub App installation token ' +
          'or PAT) to check for undiscovered PRs — see docs/07-security-and-secrets.md §3.',
      );
      const { OctokitGitHubClient } = await import('@minicoder/github');
      return new OctokitGitHubClient({ auth: token });
    }
    case 'gitea': {
      const token = requireNonBlankEnvVar(
        'GITEA_TOKEN',
        'state doctor --check-scm requires a Gitea personal/organization access token to check ' +
          'for undiscovered PRs on a Gitea-provider repository — see docs/07-security-and-secrets.md §3.2.',
      );
      if (!baseUrl) {
        throw new Error(
          `state doctor --check-scm: a Gitea-provider repository has no base_url recorded; ` +
            `cannot resolve which Gitea instance to query.`,
        );
      }
      const { GiteaScmClient } = await import('@minicoder/gitea');
      return new GiteaScmClient({ baseUrl, token });
    }
    case 'gitlab': {
      const token = requireNonBlankEnvVar(
        'GITLAB_TOKEN',
        'state doctor --check-scm requires a GitLab personal/project access token to check ' +
          'for undiscovered PRs on a GitLab-provider repository — see docs/07-security-and-secrets.md §3.2.',
      );
      if (!baseUrl) {
        throw new Error(
          `state doctor --check-scm: a GitLab-provider repository has no base_url recorded; ` +
            `cannot resolve which GitLab instance to query.`,
        );
      }
      const { GitlabScmClient } = await import('@minicoder/gitlab');
      return new GitlabScmClient({ baseUrl, token });
    }
    default:
      throw new Error(`state doctor --check-scm: unknown SCM provider "${provider}"`);
  }
}

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

// Orphaned run threshold: 2 hours (kept in sync with read-models/diagnostics.ts's own constant —
// used only by the `repair` command below, which is intentionally not extracted; see its
// module-level doc comment in packages/api/src/read-models/diagnostics.ts).
const ORPHANED_RUN_THRESHOLD_MS = 2 * 60 * 60 * 1000;

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
        const result = await validateFeatureRunStates(db, opts.project);
        const output = {
          command: 'state validate',
          projectId: opts.project ?? null,
          checkedRuns: result.checkedRuns,
          violations: result.violations,
          valid: result.valid,
          message: result.valid ? 'No unknown states found' : 'Unknown states detected',
          timestamp: isoNow(),
        };

        console.log(JSON.stringify(output, null, 2));
        if (!result.valid) {
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
    .option(
      '--check-scm',
      'Also check the linked SCM provider(s) directly for undiscovered PRs (issue #35, ' +
        'generalized in Stage 5) — opt-in, requires a provider credential ' +
        '(GITHUB_TOKEN/GITEA_TOKEN/GITLAB_TOKEN as applicable)',
    )
    .option('--check-github', '[Deprecated alias for --check-scm, kept for backward compatibility]')
    .action(async (opts: { project?: string; checkScm?: boolean; checkGithub?: boolean }) => {
      const db = await createDbClientFromEnv();
      try {
        const result = await runDoctorChecks(db, opts.project);
        const checks = [...result.checks];
        const healthy = result.healthy;

        if (opts.checkScm || opts.checkGithub) {
          const divergences = await checkPrDiscoveryDivergence(
            db,
            resolveScmClientForDoctor,
            opts.project,
          );
          checks.push({
            name: 'pr_discovery_divergence',
            severity: divergences.length > 0 ? 'warning' : 'ok',
            autoClearable: true,
            count: divergences.length,
            details: divergences,
          });
          // A live-SCM divergence is a warning, not an error — github-reconciliation's own
          // scheduled discovery pass will normally clear it on its own (GitHub only, today); report
          // it here without failing the exit code the way a real error-severity check does.
        }

        const output = {
          command: 'state doctor',
          projectId: opts.project ?? null,
          healthy,
          checks,
          timestamp: isoNow(),
        };

        console.log(JSON.stringify(output, null, 2));
        if (!healthy) {
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
        const result = await reconcileState(db, { projectId: opts.project, all: opts.all });
        console.log(
          JSON.stringify(
            {
              command: 'state reconcile',
              projectId: opts.project ?? null,
              cleared: result.cleared,
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
        const result = await exportDiagnostics(db, opts.project);
        const diagnostics = JSON.stringify(
          {
            command: 'state export-diagnostics',
            projectId: opts.project ?? null,
            ...result,
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

              // PR #73 review fix (round 3, MEDIUM-1): both writes below used the SQL keyword
              // `CURRENT_TIMESTAMP` rather than a bound `isoNow()` parameter. On SQLite,
              // `CURRENT_TIMESTAMP` produces `'YYYY-MM-DD HH:MM:SS'` (a space separator, no
              // fractional seconds, no `Z`) — a different text format than every other writer in
              // this codebase, which all use `isoNow()`'s `'YYYY-MM-DDTHH:MM:SS.sssZ'` (matching
              // the schema's own `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` column default). Because
              // SQLite orders TEXT columns lexically and the space character (0x20) sorts before
              // 'T' (0x54), a `state repair`-inserted `workflow_events` row could sort *before* an
              // ISO-formatted row that actually occurred earlier the same day — directly breaking
              // `exportWorkflowEventsToOtlp()`'s `ORDER BY occurred_at ASC, id ASC` composite
              // cursor (round 2's MEDIUM-2 fix), which assumes every `occurred_at` value is in the
              // same sortable format. PostgreSQL's `TIMESTAMPTZ` column type isn't affected (it
              // compares as a real timestamp regardless of the literal used to write it), but the
              // inconsistency was worth closing at the source for both dialects rather than
              // depending on SQLite/PostgreSQL happening to diverge safely.
              const repairTimestamp = isoNow();

              for (const run of orphanedRuns) {
                await tx.execute(
                  `UPDATE feature_runs SET current_execution_state = 'human_required', ended_at = ?, updated_at = ?
                   WHERE id = ?`,
                  [repairTimestamp, repairTimestamp, run.id],
                );
                repairs.push({
                  type: 'orphaned_run',
                  description: `feature_run ${run.id} marked human_required`,
                });
              }

              if (repairs.length > 0) {
                await tx.execute(
                  `INSERT INTO workflow_events (id, project_id, event_type, from_state, to_state, actor, payload, payload_schema_version, occurred_at, created_at)
                   VALUES (?, ?, 'state.repaired', NULL, NULL, 'operator', ?, '1.0', ?, ?)`,
                  [
                    crypto.randomUUID(),
                    opts.project,
                    JSON.stringify({ repairs, appliedAt: repairTimestamp }),
                    repairTimestamp,
                    repairTimestamp,
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
