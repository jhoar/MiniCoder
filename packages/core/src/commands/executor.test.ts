import { describe, it, expect, vi } from 'vitest';
import { TransactionalCommandExecutor } from './executor.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from './types.js';
import { CommandError } from './types.js';
import { UserRole } from '../domain/states.js';
import { AuthorizationError } from '../auth/guards.js';
import type { DbClient, TxClient } from '../persistence/types.js';

function makeActor(role: UserRole) {
  return { id: 'test-actor', role, actorKind: 'human' as const, correlationId: 'corr-1' };
}

function makeEnvelope<P>(payload: P, idempotencyKey: string, role: UserRole): CommandEnvelope<P> {
  return {
    commandId: 'cmd-1',
    idempotencyKey,
    payload,
    actor: makeActor(role),
    correlationId: 'corr-1',
  };
}

function makeResult(state: string): CommandResult<string> {
  return { commandId: 'cmd-1', accepted: true, resultingState: state, emittedEventIds: ['evt-1'] };
}

function makeDb(idempotencyRows: { result: string }[] = []): DbClient {
  return {
    query: vi.fn().mockResolvedValue(idempotencyRows),
    execute: vi.fn().mockResolvedValue(undefined),
    executeAffected: vi.fn().mockResolvedValue(1),
    transaction: vi.fn().mockImplementation(async (fn: (tx: TxClient) => Promise<unknown>) =>
      fn({
        query: vi.fn().mockResolvedValue([]),
        execute: vi.fn().mockResolvedValue(undefined),
        executeAffected: vi.fn().mockResolvedValue(1),
      }),
    ),
    close: vi.fn(),
  } as unknown as DbClient;
}

function makeHandler(
  requiredRole: UserRole,
  result: CommandResult,
): CommandHandler<unknown, string> {
  return {
    commandName: 'TestCommand',
    requiredRole,
    idempotencyScope: 'test',
    execute: vi.fn().mockResolvedValue(result),
  };
}

describe('TransactionalCommandExecutor', () => {
  it('returns cached result on idempotency hit without calling handler', async () => {
    const cached = makeResult('selected');
    const db = makeDb([{ result: JSON.stringify(cached) }]);
    const handler = makeHandler(UserRole.OPERATOR, makeResult('other'));
    const executor = new TransactionalCommandExecutor(db);

    const result = await executor.execute(handler, makeEnvelope({}, 'key-1', UserRole.OPERATOR));

    expect(result).toEqual(cached);
    expect(handler.execute).not.toHaveBeenCalled();
  });

  it('calls handler when no idempotency hit', async () => {
    const db = makeDb([]);
    const expected = makeResult('selected');
    const handler = makeHandler(UserRole.OPERATOR, expected);
    const executor = new TransactionalCommandExecutor(db);

    const result = await executor.execute(handler, makeEnvelope({}, 'key-2', UserRole.OPERATOR));

    expect(result).toEqual(expected);
    expect(handler.execute).toHaveBeenCalledOnce();
  });

  it('throws AuthorizationError when actor role is insufficient', async () => {
    const db = makeDb([]);
    const handler = makeHandler(UserRole.APPROVER, makeResult('approved'));
    const executor = new TransactionalCommandExecutor(db);

    await expect(
      executor.execute(handler, makeEnvelope({}, 'key-3', UserRole.VIEWER)),
    ).rejects.toThrow(AuthorizationError);
    expect(handler.execute).not.toHaveBeenCalled();
  });

  it('propagates CommandError thrown by handler', async () => {
    const db = makeDb([]);
    const handler = makeHandler(UserRole.OPERATOR, makeResult('x'));
    (handler.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new CommandError({ type: 'invalid-state', title: 'Invalid', status: 409, detail: 'Bad' }),
    );
    const executor = new TransactionalCommandExecutor(db);

    await expect(
      executor.execute(handler, makeEnvelope({}, 'key-4', UserRole.OPERATOR)),
    ).rejects.toThrow(CommandError);
  });
});
