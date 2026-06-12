import { Command } from 'commander';
import { spawnSync } from 'child_process';
import * as path from 'path';

const runnerPath = path.resolve(__dirname, '../../../migrations/src/runner.ts');

function runMigrationCommand(subCommand: string, extraArgs: string[] = []): void {
  const result = spawnSync('tsx', [runnerPath, subCommand, ...extraArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
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
    .description('Drop all tables and re-apply migrations (destructive)')
    .option('--yes', 'Confirm the destructive reset operation')
    .action((opts: { yes?: boolean }) => {
      if (!opts.yes) {
        console.error(
          'Error: --yes flag required to confirm destructive reset. Run: minicoder db reset --yes',
        );
        process.exit(1);
      }
      runMigrationCommand('reset', ['--yes']);
    });

  db.command('seed')
    .description('Insert development seed data')
    .action(() => runMigrationCommand('seed'));

  return db;
}
