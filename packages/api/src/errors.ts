/**
 * RFC 9457 problem-details error mapping (docs/01-system-specification.md §9). Every route error
 * — thrown by a core command handler, an auth guard, a read-model, or the request layer itself —
 * is funneled through `toProblemDetails()` and returned as Fastify's global error-handler
 * response, so every failure mode in the API has exactly one shape.
 */
import {
  AuthorizationError,
  CommandError,
  TransitionError,
  GithubMergeRejectedError,
  type ProblemDetail,
} from '@minicoder/core';

export class NotFoundError extends Error {
  constructor(
    public readonly resource: string,
    public readonly id: string,
  ) {
    super(`${resource} ${id} not found`);
    this.name = 'NotFoundError';
  }
}

export class MissingIdempotencyKeyError extends Error {
  constructor() {
    super('Idempotency-Key header is required on mutating requests');
    this.name = 'MissingIdempotencyKeyError';
  }
}

export class RequestValidationError extends Error {
  constructor(
    public readonly detail: string,
    public readonly type: string = 'validation-error',
  ) {
    super(detail);
    this.name = 'RequestValidationError';
  }
}

export class UnauthenticatedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'UnauthenticatedError';
  }
}

/** Thrown when a request's `Idempotency-Key` is currently claimed by another in-flight request
 * (see `route-idempotency.ts`) — the caller should retry shortly, not assume failure. */
export class RequestInProgressError extends Error {
  constructor(key: string) {
    super(`A request with Idempotency-Key '${key}' is already in progress; retry shortly`);
    this.name = 'RequestInProgressError';
  }
}

export interface ProblemResponse {
  status: number;
  body: ProblemDetail;
}

function problem(
  status: number,
  type: string,
  title: string,
  detail: string,
  instance?: string,
): ProblemResponse {
  return { status, body: { type, title, status, detail, instance } };
}

/**
 * Central dispatcher registered as Fastify's `setErrorHandler`. Order matters: more specific
 * error types are checked before the generic fallback.
 */
export function toProblemDetails(err: unknown, instance: string): ProblemResponse {
  // CommandError check covers MergeGateBlockedError too (it extends CommandError and already
  // carries a fully-formed `merge-gate-blocked` ProblemDetail) — no separate branch needed.
  if (err instanceof CommandError) {
    return {
      status: err.problem.status,
      body: { ...err.problem, instance: err.problem.instance ?? instance },
    };
  }
  if (err instanceof GithubMergeRejectedError) {
    const status = err.reason === 'sha_mismatch' || err.reason === 'not_mergeable' ? 409 : 502;
    return problem(
      status,
      `github-merge-${err.reason}`,
      'GitHub merge rejected',
      err.message,
      instance,
    );
  }
  if (err instanceof AuthorizationError) {
    return problem(403, 'authorization-error', 'Not authorized', err.message, instance);
  }
  if (err instanceof UnauthenticatedError) {
    return problem(401, 'unauthenticated', 'Authentication required', err.message, instance);
  }
  if (err instanceof TransitionError) {
    return problem(
      409,
      'invalid-state-transition',
      'Invalid state transition',
      err.message,
      instance,
    );
  }
  if (err instanceof NotFoundError) {
    return problem(404, 'not-found', 'Resource not found', err.message, instance);
  }
  if (err instanceof MissingIdempotencyKeyError) {
    return problem(
      400,
      'missing-idempotency-key',
      'Missing Idempotency-Key header',
      err.message,
      instance,
    );
  }
  if (err instanceof RequestValidationError) {
    return problem(400, err.type, 'Request validation failed', err.detail, instance);
  }
  if (err instanceof RequestInProgressError) {
    return problem(
      409,
      'request-in-progress',
      'Request already in progress',
      err.message,
      instance,
    );
  }
  // Never leak the raw exception message to the client — an unrecognized error can be a DB
  // driver error, a provider/SDK error, or anything else that may echo connection strings,
  // credentials, or other secret-bearing internals. Log the full detail server-side only; the
  // client gets a stable, generic body regardless of what the underlying error actually said.
  console.error(`[api] unhandled error at ${instance}:`, err);
  return problem(
    500,
    'internal-error',
    'Internal server error',
    'An unexpected error occurred. See server logs for details.',
    instance,
  );
}
