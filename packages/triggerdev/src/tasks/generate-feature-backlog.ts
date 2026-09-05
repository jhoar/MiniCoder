import {
  AdapterRegistry,
  AgentRole,
  AgentRunRecorder,
  GenerateFeatureBacklogHandler,
  TransactionalCommandExecutor,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient, PlannerAgentAdapter } from '@minicoder/core';
import type { GenerateFeatureBacklogPayload } from './types.js';
import { systemActor } from './actor.js';
import { resolvePlannerPromptTemplateVersion, computePlannerCostUsd } from './planner-cost.js';

export type { GenerateFeatureBacklogPayload };

export interface GenerateFeatureBacklogResult {
  projectId: string;
  featureCount: number;
}

const handler = new GenerateFeatureBacklogHandler();

interface PlanSectionRow {
  title: string;
  content: string;
}

/**
 * Bridges a generated implementation plan to a real feature backlog, the `generate-feature-
 * backlog` half of the same wiring gap `generate-implementation-plan.ts` closes. Two paths,
 * selected by whether the caller supplied `features` directly:
 *
 * - `features` non-empty: unchanged from before this fix — dispatches
 *   `GenerateFeatureBacklogCommand` with the caller-supplied list.
 * - `features` empty (the default): the caller instead supplies `plannerAdapterName`, and this
 *   task invokes the injected `PlannerAgentAdapter`'s `generateFeatureBacklog()` against the
 *   plan's own `plan_sections` rows (via `AgentRunRecorder`, same cost/token-recording shape
 *   `generate-implementation-plan.ts` uses), deriving `features` from its output.
 */
export async function runImpl(
  payload: GenerateFeatureBacklogPayload,
  db: DbClient,
  // Optional: only referenced when `features` is empty (the adapter-generation path). Every
  // existing caller that already supplies `features` directly never needs one.
  planner?: PlannerAgentAdapter,
): Promise<GenerateFeatureBacklogResult> {
  let features = payload.features;

  if (features.length === 0) {
    if (!payload.plannerAdapterName) {
      throw new Error(
        'generate-feature-backlog: no features supplied and no plannerAdapterName given — ' +
          'either supply features directly or set plannerAdapterName to generate them via the adapter.',
      );
    }
    if (!planner?.generateFeatureBacklog) {
      throw new Error(
        `generate-feature-backlog: adapter "${payload.plannerAdapterName}" does not implement generateFeatureBacklog().`,
      );
    }

    const sectionRows = await db.query<PlanSectionRow>(
      `SELECT title, content FROM plan_sections WHERE plan_id = ? ORDER BY order_index ASC`,
      [payload.planId],
    );
    if (sectionRows.length === 0) {
      throw new Error(
        `generate-feature-backlog: plan ${payload.planId} has no plan_sections to generate a backlog from.`,
      );
    }

    const registry = new AdapterRegistry(db);
    const recorder = new AgentRunRecorder(db, registry);
    const adapterRecord = await registry.resolve(AgentRole.PLANNER, payload.plannerAdapterName);

    const input = {
      projectId: payload.projectId,
      planId: payload.planId,
      planSections: sectionRows,
      correlationId: payload.correlationId,
    };

    const generateFeatureBacklog = planner.generateFeatureBacklog.bind(planner);
    const { output } = await recorder.record(
      {
        adapterId: adapterRecord.id,
        role: AgentRole.PLANNER,
        projectId: payload.projectId,
        input,
        capabilitiesUsed: ['can_generate_plan'],
        contextPack: { content: input },
        promptTemplateVersion: resolvePlannerPromptTemplateVersion(),
        costExtractor: (outcome) => {
          if (!outcome.ok) return null;
          const out = outcome.output as { tokensUsed?: { input: number; output: number } };
          if (!out.tokensUsed) return null;
          return {
            inputTokens: out.tokensUsed.input,
            outputTokens: out.tokensUsed.output,
            costUsd: computePlannerCostUsd(out.tokensUsed.input, out.tokensUsed.output),
            provider: process.env['CODE_GEN_PROVIDER_NAME'] ?? 'openai-compatible',
            model: process.env['CODE_GEN_MODEL'],
          };
        },
      },
      () => generateFeatureBacklog(input),
    );

    if (output.features.length === 0) {
      throw new Error(
        `generate-feature-backlog: adapter "${payload.plannerAdapterName}" generated zero features.`,
      );
    }
    features = output.features;
  }

  const resolvedPayload = { ...payload, features };

  const envelope: CommandEnvelope<typeof resolvedPayload> = {
    commandId: generateId(),
    idempotencyKey: payload.idempotencyKey,
    payload: resolvedPayload,
    actor: systemActor(payload.correlationId),
    correlationId: payload.correlationId,
  };

  const executor = new TransactionalCommandExecutor(db);
  await executor.execute(handler, envelope);

  return { projectId: payload.projectId, featureCount: features.length };
}
