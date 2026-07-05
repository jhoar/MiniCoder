import { describe, it, expect } from 'vitest';
import {
  CommandError,
  AuthorizationError,
  TransitionError,
  UserRole,
  GithubMergeRejectedError,
} from '@minicoder/core';
import {
  toProblemDetails,
  NotFoundError,
  MissingIdempotencyKeyError,
  RequestValidationError,
  UnauthenticatedError,
} from './errors.js';

const INSTANCE = '/test-instance';

describe('toProblemDetails', () => {
  it('maps CommandError by passing through its own ProblemDetail', () => {
    const err = new CommandError({
      type: 'not-found',
      title: 'Not found',
      status: 404,
      detail: 'thing missing',
    });
    const { status, body } = toProblemDetails(err, INSTANCE);
    expect(status).toBe(404);
    expect(body).toMatchObject({ type: 'not-found', title: 'Not found', status: 404 });
    expect(body.instance).toBe(INSTANCE);
  });

  it('maps AuthorizationError to 403', () => {
    const err = new AuthorizationError('actor-1', UserRole.VIEWER, UserRole.ADMIN, 'SomeCommand');
    const { status, body } = toProblemDetails(err, INSTANCE);
    expect(status).toBe(403);
    expect(body.type).toBe('authorization-error');
  });

  it('maps UnauthenticatedError to 401', () => {
    const { status, body } = toProblemDetails(new UnauthenticatedError('no key'), INSTANCE);
    expect(status).toBe(401);
    expect(body.type).toBe('unauthenticated');
  });

  it('maps TransitionError to 409', () => {
    const err = new TransitionError('coding', 'merge_ready', 'feature-execution');
    const { status, body } = toProblemDetails(err, INSTANCE);
    expect(status).toBe(409);
    expect(body.type).toBe('invalid-state-transition');
  });

  it('maps NotFoundError to 404', () => {
    const { status, body } = toProblemDetails(new NotFoundError('project', 'p1'), INSTANCE);
    expect(status).toBe(404);
    expect(body.type).toBe('not-found');
  });

  it('maps MissingIdempotencyKeyError to 400', () => {
    const { status, body } = toProblemDetails(new MissingIdempotencyKeyError(), INSTANCE);
    expect(status).toBe(400);
    expect(body.type).toBe('missing-idempotency-key');
  });

  it('maps RequestValidationError to 400 with its custom type', () => {
    const { status, body } = toProblemDetails(
      new RequestValidationError('bad limit', 'request-does-not-match-schema'),
      INSTANCE,
    );
    expect(status).toBe(400);
    expect(body.type).toBe('request-does-not-match-schema');
  });

  it('maps GithubMergeRejectedError sha_mismatch to 409', () => {
    const err = new GithubMergeRejectedError('sha moved', 'sha_mismatch', true);
    const { status, body } = toProblemDetails(err, INSTANCE);
    expect(status).toBe(409);
    expect(body.type).toBe('github-merge-sha_mismatch');
  });

  it('maps an unrecognized GithubMergeRejectedError reason to 502', () => {
    const err = new GithubMergeRejectedError('mystery', 'unknown', false);
    const { status } = toProblemDetails(err, INSTANCE);
    expect(status).toBe(502);
  });

  it('maps an unrecognized error to a redacted 500', () => {
    const { status, body } = toProblemDetails(new Error('secret internal detail'), INSTANCE);
    expect(status).toBe(500);
    expect(body.type).toBe('internal-error');
  });
});
