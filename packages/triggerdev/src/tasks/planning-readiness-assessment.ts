import {
  AdapterRegistry,
  AgentRunRecorder,
  AssessPlanningReadinessHandler,
  TransactionalCommandExecutor,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient, PlannerAgentAdapter } from '@minicoder/core';
import type { PlanningReadinessPayload } from './types.js';
import { systemActor } from './actor.js';

export type { PlanningReadinessPayload };

export interface PlanningReadinessResult {
  projectId: string;
  readinessResult: 'sufficient' | 'sufficient_with_assumptions' | 'insufficient';
}

/**
 * Real Orchestrator Core command invocation (wired in Phase 6). The concrete PlannerAgentAdapter
 * instance is injected by the caller — this file never imports a mock or reference adapter
 * implementation directly, keeping the task layer adapter-agnostic. Test scenarios pass
 * MockPlannerAdapter; a real Trigger.dev deployment will pass a reference planner adapter once
 * one exists (Phase 9+).
 */
export async function runImpl(
  payload: PlanningReadinessPayload,
  db: DbClient,
  planner: PlannerAgentAdapter,
): Promise<PlanningReadinessResult> {
  const registry = new AdapterRegistry(db);
  const recorder = new AgentRunRecorder(db, registry);
  const handler = new AssessPlanningReadinessHandler(registry, recorder, planner, payload.plannerAdapterName);

  const envelope: CommandEnvelope<typeof payload> = {
    commandId: generateId(),
    idempotencyKey: payload.idempotencyKey,
    payload,
    actor: systemActor(payload.correlationId),
    correlationId: payload.correlationId,
  };

  const executor = new TransactionalCommandExecutor(db);
  const result = await executor.execute(handler, envelope);

  return { projectId: payload.projectId, readinessResult: result.resultingState };
}
