import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { Command } from 'commander';
import { createDbCommand } from './db.js';

function spawnSyncDefaultReturn(): ReturnType<typeof spawnSync> {
  return {
    status: 0,
    stdout: null,
    stderr: null,
    pid: 1,
    output: [],
    signal: null,
  } as unknown as ReturnType<typeof spawnSync>;
}

vi.mock('child_process', () => ({
  spawnSync: vi.fn().mockReturnValue(spawnSyncDefaultReturn()),
}));

const spawnMock = vi.mocked(spawnSync);

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.addCommand(createDbCommand());
  return program;
}

describe('CLI db reset command', () => {
  // vi.restoreAllMocks() undoes vi.spyOn() replacements of process.exit/console.error (clearing
  // mocks alone resets call history but leaves the replaced implementations installed for later
  // tests — see issue #13). The spawnSync module mock isn't a spy installed per-test, so its
  // default return value must be reapplied explicitly after a restore.
  afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReturnValue(spawnSyncDefaultReturn());
  });

  const baseArgs = ['--actor', 'test-operator', '--backup-exempt', 'test run'];

  it('exits when --env flag is missing', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      makeProgram().parse(['node', 'minicoder', 'db', 'reset', '--dry-run', ...baseArgs]),
    ).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/--env/);
  });

  it('exits when --actor is missing', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      makeProgram().parse([
        'node',
        'minicoder',
        'db',
        'reset',
        '--dry-run',
        '--env',
        'development',
        '--backup-exempt',
        'test run',
      ]),
    ).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/--actor/);
  });

  it('exits when neither --dry-run nor --apply is passed', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      makeProgram().parse([
        'node',
        'minicoder',
        'db',
        'reset',
        '--env',
        'development',
        ...baseArgs,
      ]),
    ).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/--dry-run|--apply/);
  });

  it('exits when --apply is passed without --yes', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      makeProgram().parse([
        'node',
        'minicoder',
        'db',
        'reset',
        '--apply',
        '--confirmation',
        'tok',
        '--env',
        'development',
        ...baseArgs,
      ]),
    ).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/--yes/);
  });

  it('forwards --dry-run, --env, --actor, and --backup-exempt to the runner subprocess', () => {
    makeProgram().parse([
      'node',
      'minicoder',
      'db',
      'reset',
      '--dry-run',
      '--env',
      'development',
      ...baseArgs,
    ]);

    expect(spawnMock).toHaveBeenCalledWith(
      'tsx',
      expect.arrayContaining([
        'reset',
        '--env',
        'development',
        '--actor',
        'test-operator',
        '--dry-run',
        '--backup-exempt',
        'test run',
      ]),
      expect.any(Object),
    );
  });

  it('forwards --apply --yes --confirmation to the runner subprocess', () => {
    makeProgram().parse([
      'node',
      'minicoder',
      'db',
      'reset',
      '--apply',
      '--yes',
      '--confirmation',
      'the-token',
      '--env',
      'development',
      ...baseArgs,
    ]);

    expect(spawnMock).toHaveBeenCalledWith(
      'tsx',
      expect.arrayContaining(['--apply', '--yes', '--confirmation', 'the-token']),
      expect.any(Object),
    );
  });

  it('forwards arbitrary --env values to the runner (validation is runner-side)', () => {
    // The CLI passes through whatever --env value was given; the runner enforces
    // the allowlist so the CLI never silently swallows the user-supplied value.
    makeProgram().parse([
      'node',
      'minicoder',
      'db',
      'reset',
      '--dry-run',
      '--env',
      'staging',
      ...baseArgs,
    ]);

    expect(spawnMock).toHaveBeenCalledWith(
      'tsx',
      expect.arrayContaining(['--env', 'staging']),
      expect.any(Object),
    );
  });

  it('leaves process.exit and console.error restored after a test that installs spies', () => {
    // Regression for issue #13: confirms the previous test's spies didn't leak.
    expect(vi.isMockFunction(process.exit)).toBe(false);
    expect(vi.isMockFunction(console.error)).toBe(false);
  });
});
