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
    .description('Drop all owned tables and re-apply migrations (destructive, dev/CI only)')
    .option('--yes', 'Confirm the destructive reset operation')
    .option('--env <environment>', 'Target environment — must be development, test, or ci')
    .action((opts: { yes?: boolean; env?: string }) => {
      if (!opts.yes) {
        console.error(
          'Error: --yes and --env <environment> flags are required.\n' +
            'Example: minicoder db reset --yes --env development',
        );
        process.exit(1);
      }
      if (!opts.env) {
        console.error(
          'Error: --env <environment> is required.\n' +
            'Example: minicoder db reset --yes --env development\n' +
            'Permitted values: development, test, ci',
        );
        process.exit(1);
      }
      runMigrationCommand('reset', ['--yes', '--env', opts.env]);
    });

  db.command('seed')
    .description('Insert development seed data')
    .action(() => runMigrationCommand('seed'));

  return db;
}
