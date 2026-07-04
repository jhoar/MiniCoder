/**
 * Bounded-diff / disallowed-path enforcement (docs/03 §11.3 — "output as a bounded diff; max
 * diff size, disallowed paths rejected"). Runs as application logic on top of — not instead of —
 * the container's own isolation (CLAUDE.md's Reference Coder Adapter Operational Constraints).
 * Pure functions over a parsed changed-file list so they're unit-testable without git or Docker.
 */

const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_BYTES = 500_000;

const DEFAULT_DISALLOWED_PATH_GLOBS = [
  /^\.github\/workflows\//,
  /^\.git\//,
  /(^|\/)\.env(\..+)?$/,
  /(^|\/)secrets\//,
];

export interface ChangedFile {
  readonly path: string;
  readonly bytesChanged: number;
}

export interface DiffGuardOptions {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly disallowedPathPatterns?: readonly RegExp[];
}

export class DiffGuardViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffGuardViolationError';
  }
}

/** Throws DiffGuardViolationError if the diff exceeds bounds or touches a disallowed path. */
export function assertDiffWithinBounds(
  changedFiles: readonly ChangedFile[],
  options: DiffGuardOptions = {},
): void {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const disallowed = options.disallowedPathPatterns ?? DEFAULT_DISALLOWED_PATH_GLOBS;

  if (changedFiles.length === 0) {
    throw new DiffGuardViolationError('coder run produced no file changes');
  }
  if (changedFiles.length > maxFiles) {
    throw new DiffGuardViolationError(
      `diff touches ${changedFiles.length} files, exceeding the max of ${maxFiles}`,
    );
  }
  const totalBytes = changedFiles.reduce((sum, f) => sum + f.bytesChanged, 0);
  if (totalBytes > maxBytes) {
    throw new DiffGuardViolationError(
      `diff changes ${totalBytes} bytes, exceeding the max of ${maxBytes}`,
    );
  }
  for (const file of changedFiles) {
    if (disallowed.some((pattern) => pattern.test(file.path))) {
      throw new DiffGuardViolationError(`diff touches a disallowed path: ${file.path}`);
    }
  }
}
