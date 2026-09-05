import { Command } from 'commander';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createDbClientFromEnv } from '../db-client.js';

const runnerPath = path.resolve(__dirname, '../../../migrations/src/runner.ts');

const ALLOWED_ENVS = new Set(['development', 'test', 'ci']);
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations/migrations');

function runMigrationCommand(subCommand: string, extraArgs: string[] = []): void {
  const result = spawnSync('tsx', [runnerPath, subCommand, ...extraArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  // `spawnSync` failing to even launch the child (e.g. `tsx` not resolvable on PATH) reports
  // `status: null` with no stdout/stderr from the child — silently exiting on that alone (the
  // original bug: `result.status !== 0` is true for `null`, so this always ran, but the caller
  // saw nothing but a bare `exit 1`) gives no clue what went wrong. Surface `result.error`
  // explicitly first.
  if (result.error) {
    console.error(`Failed to run migration command '${subCommand}': ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function guardEnv(env: string | undefined): void {
  if (process.env['APP_ENV'] === 'production' || process.env['NODE_ENV'] === 'production') {
    console.error('Error: this command is not permitted when APP_ENV or NODE_ENV is production.');
    process.exit(1);
  }
  const target = env ?? process.env['APP_ENV'] ?? process.env['NODE_ENV'] ?? 'production';
  if (!ALLOWED_ENVS.has(target)) {
    console.error(
      `Error: this command is only permitted in development/test/ci environments.\n` +
        `Target env: '${target}'. Pass --env development or set APP_ENV=development.`,
    );
    process.exit(1);
  }
}

export function createDbCommand(): Command {
  const db = new Command('db').description('Database lifecycle commands');

  db.command('migrate')
    .description('Apply pending migrations')
    .action(() => runMigrationCommand('migrate'));

  db.command('rollback')
    .description('Roll back the last applied migration')
    .action(() => runMigrationCommand('rollback'));

  db.command('status')
    .description('Show applied and pending migrations')
    .action(() => runMigrationCommand('status'));

  db.command('validate')
    .description('Verify all expected tables and indexes exist')
    .action(() => runMigrationCommand('validate'));

  db.command('reset')
    .description(
      'Drop all owned tables and re-apply migrations (destructive, dev/CI only). ' +
        'Two-step: run --dry-run first to get a confirmation token, then --apply --confirmation <token>.',
    )
    .option('--yes', 'Confirm the destructive reset operation (required with --apply)')
    .option('--env <environment>', 'Target environment — must be development, test, or ci')
    .option('--dry-run', 'Preview the reset and issue a single-use confirmation token')
    .option('--apply', 'Perform the reset (requires --confirmation from a prior --dry-run)')
    .option('--confirmation <token>', 'Confirmation token issued by --dry-run')
    .option('--actor <name>', 'Who is authorizing this destructive action (required)')
    .option('--backup-verified', 'Confirm a backup was taken before reset')
    .option('--backup-exempt <reason>', 'Document why no backup is needed instead of verifying one')
    .option(
      '--disposable-db',
      'Acknowledge this is a known disposable target when APP_ENV/NODE_ENV is unset',
    )
    .option('--force-host', 'Explicitly override the PostgreSQL reset-target host allowlist')
    .action(
      (opts: {
        yes?: boolean;
        env?: string;
        dryRun?: boolean;
        apply?: boolean;
        confirmation?: string;
        actor?: string;
        backupVerified?: boolean;
        backupExempt?: string;
        disposableDb?: boolean;
        forceHost?: boolean;
      }) => {
        if (!opts.env) {
          console.error(
            'Error: --env <environment> is required.\n' +
              'Example: minicoder db reset --dry-run --env development --actor <name> --backup-exempt "local dev"\n' +
              'Permitted values: development, test, ci',
          );
          process.exit(1);
        }
        if (!opts.actor) {
          console.error('Error: --actor <name> is required.');
          process.exit(1);
        }
        if (!opts.dryRun && !opts.apply) {
          console.error('Error: pass either --dry-run or --apply --confirmation <token>.');
          process.exit(1);
        }
        if (opts.apply && !opts.yes) {
          console.error('Error: --apply requires --yes.');
          process.exit(1);
        }
        const extraArgs = ['--env', opts.env, '--actor', opts.actor];
        if (opts.yes) extraArgs.push('--yes');
        if (opts.dryRun) extraArgs.push('--dry-run');
        if (opts.apply) extraArgs.push('--apply');
        if (opts.confirmation) extraArgs.push('--confirmation', opts.confirmation);
        if (opts.backupVerified) extraArgs.push('--backup-verified');
        if (opts.backupExempt) extraArgs.push('--backup-exempt', opts.backupExempt);
        if (opts.disposableDb) extraArgs.push('--disposable-db');
        if (opts.forceHost) extraArgs.push('--force-host');
        runMigrationCommand('reset', extraArgs);
      },
    );

  db.command('seed')
    .description('Insert fixture data into the database (dev/CI only, SQLite only)')
    .option('--fixture <name>', 'Fixture name', 'planning-review-merge')
    .option('--env <environment>', 'Target environment — must be development, test, or ci')
    .option('--project <id>', 'Project ID override')
    .action(async (opts: { fixture: string; env?: string; project?: string }) => {
      guardEnv(opts.env);
      const dialect = process.env['DB_DIALECT'] ?? 'sqlite';
      if (dialect === 'postgres') {
        console.error(
          'Error: db seed is only supported with SQLite.\n' +
            'For PostgreSQL, use pg_restore to load fixture data.',
        );
        process.exit(1);
      }
      const { getFixture } = await import('@minicoder/testing');
      const dbClient = await createDbClientFromEnv();
      try {
        const fixture = getFixture(opts.fixture as Parameters<typeof getFixture>[0]);
        await fixture.setup(dbClient, opts.project);
        const auditEntry = {
          command: 'db seed',
          fixture: opts.fixture,
          projectId: opts.project ?? '(default)',
          timestamp: isoNow(),
        };
        console.log(JSON.stringify(auditEntry, null, 2));
        console.log(`Fixture '${opts.fixture}' applied successfully.`);
      } finally {
        await dbClient.close();
      }
    });

  db.command('snapshot')
    .description('Snapshot the current SQLite database to a file')
    .requiredOption('--output <path>', 'Output file path (must not already exist)')
    .action((opts: { output: string }) => {
      const dialect = process.env['DB_DIALECT'] ?? 'sqlite';
      if (dialect !== 'sqlite') {
        console.error(
          'Error: db snapshot is only supported for SQLite.\n' +
            'For PostgreSQL, use pg_dump to create a snapshot.',
        );
        process.exit(1);
      }
      const dbPath = process.env['DB_PATH'] ?? './minicoder.db';
      if (fs.existsSync(opts.output)) {
        console.error(`Error: output path '${opts.output}' already exists. Remove it first.`);
        process.exit(1);
      }
      fs.copyFileSync(dbPath, opts.output);
      const sidecar = {
        snapshotAt: isoNow(),
        sourcePath: dbPath,
        dialect: 'sqlite',
      };
      fs.writeFileSync(`${opts.output}.meta.json`, JSON.stringify(sidecar, null, 2), 'utf-8');
      console.log(`Snapshot written to '${opts.output}' (metadata: ${opts.output}.meta.json)`);
    });

  db.command('restore')
    .description('Restore a SQLite database from a snapshot file (dev/CI only)')
    .requiredOption('--input <path>', 'Snapshot file path')
    .option('--env <environment>', 'Target environment — must be development, test, or ci')
    .option('--yes', 'Confirm the restore (will overwrite existing database)')
    .action((opts: { input: string; env?: string; yes?: boolean }) => {
      guardEnv(opts.env);
      const dialect = process.env['DB_DIALECT'] ?? 'sqlite';
      if (dialect !== 'sqlite') {
        console.error(
          'Error: db restore is only supported for SQLite.\n' +
            'For PostgreSQL, use pg_restore to restore from a pg_dump snapshot.',
        );
        process.exit(1);
      }
      if (!opts.yes) {
        console.error(
          'Error: --yes is required to confirm the restore operation.\n' +
            'Example: minicoder db restore --input ./snapshot.db --yes --env development',
        );
        process.exit(1);
      }
      if (!fs.existsSync(opts.input)) {
        console.error(`Error: snapshot file '${opts.input}' does not exist.`);
        process.exit(1);
      }
      const dbPath = process.env['DB_PATH'] ?? './minicoder.db';
      fs.copyFileSync(opts.input, dbPath);
      console.log(
        JSON.stringify(
          { command: 'db restore', input: opts.input, target: dbPath, timestamp: isoNow() },
          null,
          2,
        ),
      );
      console.log(`Database restored from '${opts.input}' to '${dbPath}'.`);
    });

  db.command('diff')
    .description('List pending migrations not yet applied to the database')
    .action(async () => {
      const dbClient = await createDbClientFromEnv();
      try {
        const appliedRows = await dbClient.query<{ name: string }>(
          'SELECT name FROM _migrations ORDER BY name',
          [],
        );
        const appliedSet = new Set(appliedRows.map((r) => r.name));

        const migrationFiles = fs
          .readdirSync(MIGRATIONS_DIR)
          .filter(
            (f) =>
              (f.endsWith('.sqlite.sql') || f.endsWith('.postgres.sql')) && !f.includes('.down.'),
          )
          .sort()
          .map((f) => f.replace(/\.(sqlite|postgres)\.sql$/, ''));

        const pending = [...new Set(migrationFiles)].filter((n) => !appliedSet.has(n));

        console.log(
          JSON.stringify(
            {
              applied: appliedRows.map((r) => r.name),
              pending,
              upToDate: pending.length === 0,
              timestamp: isoNow(),
            },
            null,
            2,
          ),
        );
      } finally {
        await dbClient.close();
      }
    });

  return db;
}
