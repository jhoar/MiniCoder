import { Command } from 'commander';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function isoNow(): string {
  return new Date().toISOString();
}

function ttlIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// Confirmation token TTL: 5 minutes
const CONFIRMATION_TOKEN_TTL_MS = 5 * 60 * 1000;

const REPAIR_PENDING_DIR = path.join(os.homedir(), '.minicoder');
const REPAIR_PENDING_FILE = path.join(REPAIR_PENDING_DIR, 'pending-repair-token.json');

export function createStateCommand(): Command {
  const state = new Command('state').description('Workflow state lifecycle commands');

  state
    .command('inspect')
    .description('Show current state of a project or feature run')
    .option('--project <id>', 'Project ID')
    .option('--feature-run <id>', 'Feature run ID')
    .action((opts: { project?: string; featureRun?: string }) => {
      if (!opts.project && !opts.featureRun) {
        console.error('Error: --project or --feature-run is required');
        process.exit(1);
      }
      // Full implementation wires to DbClient in Phase 13 (API layer).
      // In Phase 2 this command is scaffolded; actual DB queries added in Phase 4+.
      console.log(
        JSON.stringify(
          {
            command: 'state inspect',
            projectId: opts.project ?? null,
            featureRunId: opts.featureRun ?? null,
            note: 'DB wire-up in Phase 4',
            timestamp: isoNow(),
          },
          null,
          2,
        ),
      );
    });

  state
    .command('validate')
    .description('Validate all active state machines against the transition matrix')
    .option('--project <id>', 'Project ID')
    .action((opts: { project?: string }) => {
      console.log(
        JSON.stringify(
          {
            command: 'state validate',
            projectId: opts.project ?? null,
            note: 'Transition matrix loaded; DB-backed validation in Phase 4',
            timestamp: isoNow(),
          },
          null,
          2,
        ),
      );
    });

  state
    .command('doctor')
    .description('Detect stale locks, stuck outbox/inbox events, and orphaned runs')
    .option('--project <id>', 'Project ID')
    .action((opts: { project?: string }) => {
      console.log(
        JSON.stringify(
          {
            command: 'state doctor',
            projectId: opts.project ?? null,
            checks: ['stale_locks', 'stuck_outbox', 'stuck_inbox', 'orphaned_runs'],
            note: 'DB-backed diagnostics in Phase 4',
            timestamp: isoNow(),
          },
          null,
          2,
        ),
      );
    });

  state
    .command('reconcile')
    .description('Re-apply transition matrix validation and clear auto-clearable anomalies')
    .option('--project <id>', 'Project ID')
    .action((opts: { project?: string }) => {
      console.log(
        JSON.stringify(
          {
            command: 'state reconcile',
            projectId: opts.project ?? null,
            note: 'DB-backed reconciliation in Phase 4',
            timestamp: isoNow(),
          },
          null,
          2,
        ),
      );
    });

  state
    .command('export-diagnostics')
    .description('Export full state diagnostics as JSON')
    .option('--project <id>', 'Project ID')
    .option('--output <path>', 'Output file path (default: stdout)')
    .action((opts: { project?: string; output?: string }) => {
      const diagnostics = JSON.stringify(
        {
          command: 'state export-diagnostics',
          projectId: opts.project ?? null,
          note: 'DB-backed diagnostics in Phase 4',
          timestamp: isoNow(),
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
      (opts: { project?: string; dryRun?: boolean; apply?: boolean; confirmation?: string }) => {
        if (opts.apply && !opts.dryRun) {
          if (!opts.confirmation) {
            console.error('Error: --apply requires --confirmation <token> (run --dry-run first)');
            process.exit(1);
          }
          let pendingToken: { token: string; expiresAt: string; projectId: string | null };
          try {
            const raw = fs.readFileSync(REPAIR_PENDING_FILE, 'utf-8');
            pendingToken = JSON.parse(raw) as { token: string; expiresAt: string; projectId: string | null };
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
            console.error('Error: confirmation token has expired. Run --dry-run again to get a new token.');
            process.exit(1);
          }
          // Project binding: token must have been issued for the same project
          if (pendingToken.projectId !== null && opts.project !== pendingToken.projectId) {
            console.error(`Error: token was issued for project "${pendingToken.projectId}" but --project is "${opts.project ?? '(none)'}"`);
            process.exit(1);
          }
          // Single-use: delete the pending token file before executing
          fs.unlinkSync(REPAIR_PENDING_FILE);
          console.log(
            JSON.stringify(
              {
                command: 'state repair --apply',
                projectId: opts.project ?? null,
                token: opts.confirmation,
                result: 'accepted',
                note: 'DB-backed repair execution in Phase 4',
                timestamp: isoNow(),
              },
              null,
              2,
            ),
          );
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
              previewChanges: [],
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
