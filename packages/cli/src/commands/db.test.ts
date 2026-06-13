import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { Command } from 'commander';
import { createDbCommand } from './db.js';

vi.mock('child_process', () => ({
  spawnSync: vi.fn().mockReturnValue({
    status: 0,
    stdout: null,
    stderr: null,
    pid: 1,
    output: [],
    signal: null,
  }),
}));

const spawnMock = vi.mocked(spawnSync);

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.addCommand(createDbCommand());
  return program;
}

describe('CLI db reset command', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exits when --env flag is missing (only --yes supplied)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => makeProgram().parse(['node', 'minicoder', 'db', 'reset', '--yes'])).toThrow(
      'process.exit',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/--env/);
  });

  it('exits when --yes flag is missing (only --env supplied)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      makeProgram().parse(['node', 'minicoder', 'db', 'reset', '--env', 'development']),
    ).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/--yes/);
  });

  it('forwards --yes and --env to the runner subprocess when both are supplied', () => {
    makeProgram().parse(['node', 'minicoder', 'db', 'reset', '--yes', '--env', 'development']);

    expect(spawnMock).toHaveBeenCalledWith(
      'tsx',
      expect.arrayContaining(['reset', '--yes', '--env', 'development']),
      expect.any(Object),
    );
  });

  it('forwards arbitrary --env values to the runner (validation is runner-side)', () => {
    // The CLI passes through whatever --env value was given; the runner enforces
    // the allowlist so the CLI never silently swallows the user-supplied value.
    makeProgram().parse(['node', 'minicoder', 'db', 'reset', '--yes', '--env', 'staging']);

    expect(spawnMock).toHaveBeenCalledWith(
      'tsx',
      expect.arrayContaining(['--env', 'staging']),
      expect.any(Object),
    );
  });
});
