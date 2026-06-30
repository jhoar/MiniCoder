import { Command } from 'commander';
import { spawnSync } from 'child_process';
import * as path from 'path';

function runVitest(...extraArgs: string[]): void {
  const args = ['exec', 'vitest', 'run', ...extraArgs];
  const result = spawnSync('pnpm', args, {
    stdio: 'inherit',
    env: process.env,
    cwd: path.resolve(__dirname, '../../../..'),
  });
  process.exit(result.status ?? 1);
}

async function runSystemScenario(name: string): Promise<void> {
  const { runScenario } = await import('@minicoder/testing');
  const result = await runScenario(name);
  console.log(
    JSON.stringify(
      {
        scenario: name,
        passed: result.passed,
        durationMs: result.durationMs,
        error: result.error ?? null,
        assertions: result.assertions,
      },
      null,
      2,
    ),
  );
  if (!result.passed) {
    process.exit(1);
  }
}

async function runAllSystemScenarios(): Promise<void> {
  const { runAllScenarios } = await import('@minicoder/testing');
  const results = await runAllScenarios();
  console.log(JSON.stringify(results, null, 2));
  if (results.failed > 0) {
    console.error(`\n${results.failed} scenario(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.passed} scenario(s) passed.`);
}

export function createTestCommand(): Command {
  const test = new Command('test').description('Run tests at various levels');

  test
    .command('unit')
    .description('Run unit tests (all test files; no *.integration.test.ts files exist yet)')
    .action(() => {
      // vitest 1.6.x has no --include/--exclude CLI flags; positional arg filters by file path
      runVitest('--reporter=verbose');
    });

  test
    .command('integration')
    .description('Run integration tests — only *.integration.test.ts files')
    .action(() => {
      // positional arg matches against file paths (vitest 1.6.x does not support --include)
      runVitest('--reporter=verbose', 'integration.test');
    });

  test
    .command('system')
    .description('Run all system scenarios')
    .action(() => {
      runAllSystemScenarios().catch((err: unknown) => {
        console.error('System test failed:', err);
        process.exit(1);
      });
    });

  test
    .command('scenario <name>')
    .description('Run a single system scenario by name')
    .action((name: string) => {
      runSystemScenario(name).catch((err: unknown) => {
        console.error('Scenario failed:', err);
        process.exit(1);
      });
    });

  return test;
}
