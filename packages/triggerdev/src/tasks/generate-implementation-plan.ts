import {
  AdapterRegistry,
  AgentRole,
  AgentRunRecorder,
  GenerateImplementationPlanHandler,
  TransactionalCommandExecutor,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient, PlannerAgentAdapter } from '@minicoder/core';
import type { GenerateImplementationPlanPayload } from './types.js';
import { systemActor } from './actor.js';
import { resolvePlannerPromptTemplateVersion, computePlannerCostUsd } from './planner-cost.js';

export type { GenerateImplementationPlanPayload };

export interface GenerateImplementationPlanResult {
  projectId: string;
  planId: string | null;
}

const handler = new GenerateImplementationPlanHandler();

interface SpecificationRow {
  content: string;
}

/**
 * Bridges "readiness assessment is sufficient" to a real implementation plan (issue: closing the
 * gap CLAUDE.md's issue #32 notes left open — `GenericLLMPlannerAdapter.generatePlanSections()`
 * existed but nothing ever called it). Two paths, selected by whether the caller supplied
 * `sections` directly:
 *
 * - `sections` non-empty: unchanged from before this fix — the caller has already assembled plan
 *   content by hand (or via some other means) and this task just dispatches
 *   `GenerateImplementationPlanCommand` with it, requiring `title`.
 * - `sections` empty (the default): the caller instead supplies `plannerAdapterName`, and this
 *   task invokes the injected `PlannerAgentAdapter`'s `generatePlanSections()` against the
 *   assessment's own ingested specification content (via `AgentRunRecorder`, recording context
 *   pack, token usage, and cost the same way `run-coder.ts` does for the Coder role), deriving
 *   `title`/`summary`/`sections` from its output.
 *
 * `planner` is caller-injected, never a concrete adapter import in this file — the same
 * adapter-agnostic posture `planning-readiness-assessment.ts` already established; test
 * scenarios pass `MockPlannerAdapter`, a real deployment passes `resolveDefaultPlannerAdapter()`'s
 * `GenericLLMPlannerAdapter` (wired in `task-registry.ts`).
 */
export async function runImpl(
  payload: GenerateImplementationPlanPayload,
  db: DbClient,
  // Optional: only referenced when `sections` is empty (the adapter-generation path). Every
  // existing caller that already supplies `sections` directly never needs one.
  planner?: PlannerAgentAdapter,
): Promise<GenerateImplementationPlanResult> {
  let title = payload.title;
  let summary = payload.summary ?? null;
  let sections = payload.sections;

  if (sections.length === 0) {
    if (!payload.plannerAdapterName) {
      throw new Error(
        'generate-implementation-plan: no sections supplied and no plannerAdapterName given — ' +
          'either supply sections directly or set plannerAdapterName to generate them via the adapter.',
      );
    }
    if (!planner?.generatePlanSections) {
      throw new Error(
        `generate-implementation-plan: adapter "${payload.plannerAdapterName}" does not implement generatePlanSections().`,
      );
    }

    const specRows = await db.query<SpecificationRow>(
      `SELECT si.content
       FROM specification_inputs si
       JOIN planning_readiness_assessments pra ON pra.specification_input_id = si.id
       WHERE pra.id = ? AND pra.project_id = ?`,
      [payload.assessmentId, payload.projectId],
    );
    const specificationContent = specRows[0]?.content;
    if (specificationContent === undefined) {
      throw new Error(
        `generate-implementation-plan: no specification found for assessment ${payload.assessmentId} ` +
          `in project ${payload.projectId}.`,
      );
    }

    const registry = new AdapterRegistry(db);
    const recorder = new AgentRunRecorder(db, registry);
    const adapterRecord = await registry.resolve(AgentRole.PLANNER, payload.plannerAdapterName);

    const input = {
      projectId: payload.projectId,
      assessmentId: payload.assessmentId,
      specificationContent,
      correlationId: payload.correlationId,
    };

    const generatePlanSections = planner.generatePlanSections.bind(planner);
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
      () => generatePlanSections(input),
    );

    title = output.title;
    summary = output.summary ?? null;
    sections = output.sections;
  }

  if (title === undefined) {
    throw new Error(
      'generate-implementation-plan: title is required when sections are supplied directly.',
    );
  }

  const resolvedPayload = { ...payload, title, summary, sections };

  const envelope: CommandEnvelope<typeof resolvedPayload> = {
    commandId: generateId(),
    idempotencyKey: payload.idempotencyKey,
    payload: resolvedPayload,
    actor: systemActor(payload.correlationId),
    correlationId: payload.correlationId,
  };

  const executor = new TransactionalCommandExecutor(db);
  await executor.execute(handler, envelope);

  const rows = await db.query<{ id: string }>(
    `SELECT id FROM implementation_plans WHERE project_id = ? AND assessment_id = ? ORDER BY created_at DESC LIMIT 1`,
    [payload.projectId, payload.assessmentId],
  );
  return { projectId: payload.projectId, planId: rows[0]?.id ?? null };
}
