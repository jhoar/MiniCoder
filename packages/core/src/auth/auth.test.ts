import { describe, it, expect } from 'vitest';
import { LocalAuthProvider } from './local-auth.js';
import { assertRole, meetsRole, AuthorizationError } from './guards.js';
import { UserRole } from '../domain/states.js';

describe('LocalAuthProvider', () => {
  it('issues a context with the configured role and a correlationId', () => {
    const provider = new LocalAuthProvider({ actorId: 'user-1', role: UserRole.OPERATOR });
    const ctx = provider.issueContext();
    expect(ctx.actor.id).toBe('user-1');
    expect(ctx.actor.role).toBe(UserRole.OPERATOR);
    expect(ctx.actor.correlationId).toBeTruthy();
    expect(ctx.issuedAt).toBeTruthy();
    expect(ctx.expiresAt).toBeTruthy();
  });

  it('issues a system context with admin role', () => {
    const provider = new LocalAuthProvider({ actorId: 'user-1', role: UserRole.VIEWER });
    const ctx = provider.issueSystemContext();
    expect(ctx.actor.id).toBe('system');
    expect(ctx.actor.role).toBe(UserRole.ADMIN);
    expect(ctx.expiresAt).toBeUndefined();
  });

  it('generates unique correlationIds', () => {
    const provider = new LocalAuthProvider({ actorId: 'user-1', role: UserRole.OPERATOR });
    const ids = new Set([
      provider.issueContext().actor.correlationId,
      provider.issueContext().actor.correlationId,
      provider.issueContext().actor.correlationId,
    ]);
    expect(ids.size).toBe(3);
  });
});

describe('meetsRole', () => {
  it('viewer does not meet operator', () => {
    expect(meetsRole(UserRole.VIEWER, UserRole.OPERATOR)).toBe(false);
  });
  it('operator meets operator', () => {
    expect(meetsRole(UserRole.OPERATOR, UserRole.OPERATOR)).toBe(true);
  });
  it('approver meets operator', () => {
    expect(meetsRole(UserRole.APPROVER, UserRole.OPERATOR)).toBe(true);
  });
  it('admin meets approver', () => {
    expect(meetsRole(UserRole.ADMIN, UserRole.APPROVER)).toBe(true);
  });
  it('operator does not meet approver', () => {
    expect(meetsRole(UserRole.OPERATOR, UserRole.APPROVER)).toBe(false);
  });
});

describe('assertRole', () => {
  it('throws AuthorizationError when role is insufficient', () => {
    const actor = {
      id: 'u1',
      role: UserRole.VIEWER,
      actorKind: 'human' as const,
      correlationId: 'c1',
    };
    expect(() => assertRole(actor, UserRole.OPERATOR, 'SomeCommand')).toThrow(AuthorizationError);
  });

  it('does not throw when role is sufficient', () => {
    const actor = {
      id: 'u1',
      role: UserRole.APPROVER,
      actorKind: 'human' as const,
      correlationId: 'c1',
    };
    expect(() => assertRole(actor, UserRole.OPERATOR, 'SomeCommand')).not.toThrow();
  });
});
