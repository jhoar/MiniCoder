/**
 * Populates `@minicoder/core`'s `CommandRegistry` — its first production consumer (every other
 * caller in this repo `new`s a concrete handler class directly). Only handlers safe for direct,
 * generic HTTP dispatch are registered here:
 *
 *  - All `human`-actorKind command handlers except `MergeIfReadyHandler`, which needs a dedicated
 *    route (it chains a real GitHub API call between two command dispatches — see
 *    `merge-if-ready-route.ts`).
 *  - A small, deliberate allow-list of `system`-actorKind handlers (generate-implementation-plan,
 *    generate-feature-backlog, validate-backlog) reachable only via `system`-actorKind API keys,
 *    for manual replay of a stuck system-owned transition. These handlers take their computed
 *    inputs directly in the payload and have no-argument constructors, so generic dispatch is
 *    safe. `assess-planning-readiness` is NOT included — its handler's constructor requires a
 *    live `PlannerAgentAdapter` instance, and no reference planner adapter has shipped yet (see
 *    the comment at its call site below).
 *
 * Every other `system`-actorKind handler (GitHub reconciliation, coder/reviewer pipeline
 * transitions, etc.) is intentionally excluded — those are internal orchestration mechanics
 * driven by specific side-channel data (commit SHAs, adapter outputs) that no external caller
 * should invoke directly. This keeps "no arbitrary state-mutation endpoints" a structural
 * property of the API, not just a convention.
 */
import {
  CommandRegistry,
  IngestSpecificationHandler,
  ApprovePlanHandler,
  ActivatePlanHandler,
  SubmitPlanForApprovalHandler,
  ExportPlanHandler,
  ExportBacklogHandler,
  ImportBacklogHandler,
  StartClarificationHandler,
  RecordClarificationAnswerHandler,
  CompleteClarificationHandler,
  SelectFeatureHandler,
  ResolveDisagreementHandler,
  ResumeFeatureExecutionHandler,
  RetryFeatureHandler,
  SkipFeatureHandler,
  BlockFeatureHandler,
  PauseAutomationHandler,
  ResumeAutomationHandler,
  ApproveBudgetOverrideHandler,
  GenerateImplementationPlanHandler,
  GenerateFeatureBacklogHandler,
  ValidateBacklogHandler,
  GenerateDesignDocumentHandler,
  RequestDesignDocumentRevisionHandler,
  RegenerateDesignDocumentHandler,
  ApproveDesignDocumentHandler,
  MarkImplementationCompleteHandler,
  RecordDesignDocumentReadyHandler,
  ExportDesignDocumentHandler,
  CompleteProjectHandler,
} from '@minicoder/core';

export function buildCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();

  // Human-actorKind handlers (generic dispatch).
  registry.register(new IngestSpecificationHandler());
  registry.register(new ApprovePlanHandler());
  registry.register(new ActivatePlanHandler());
  registry.register(new SubmitPlanForApprovalHandler());
  registry.register(new ExportPlanHandler());
  registry.register(new ExportBacklogHandler());
  registry.register(new ImportBacklogHandler());
  registry.register(new StartClarificationHandler());
  registry.register(new RecordClarificationAnswerHandler());
  registry.register(new CompleteClarificationHandler());
  registry.register(new SelectFeatureHandler());
  registry.register(new ResolveDisagreementHandler());
  registry.register(new ResumeFeatureExecutionHandler());
  registry.register(new RetryFeatureHandler());
  registry.register(new SkipFeatureHandler());
  registry.register(new BlockFeatureHandler());
  registry.register(new PauseAutomationHandler());
  registry.register(new ResumeAutomationHandler());
  registry.register(new ApproveBudgetOverrideHandler());

  // Phase 17: human-actorKind project-lifecycle/design-document handlers.
  registry.register(new GenerateDesignDocumentHandler());
  registry.register(new RequestDesignDocumentRevisionHandler());
  registry.register(new RegenerateDesignDocumentHandler());
  registry.register(new ApproveDesignDocumentHandler());

  // System-actorKind handlers, reachable only via a system-kind API key (manual replay).
  // AssessPlanningReadinessHandler is deliberately excluded: unlike the other system handlers,
  // its constructor requires a live PlannerAgentAdapter instance (registry, recorder, adapter,
  // adapterName), and no reference planner adapter has shipped yet (docs/02 §7 names
  // GenericLLMPlannerAdapter as future work) — the same "no default adapter, inject only" posture
  // `planning-readiness-assessment.ts`'s Trigger.dev task already documents.
  registry.register(new GenerateImplementationPlanHandler());
  registry.register(new GenerateFeatureBacklogHandler());
  registry.register(new ValidateBacklogHandler());
  // Phase 17: system-actorKind project-lifecycle handlers, for manual replay of a stuck
  // system-owned transition (same posture as the three handlers above).
  registry.register(new MarkImplementationCompleteHandler());
  registry.register(new RecordDesignDocumentReadyHandler());
  registry.register(new ExportDesignDocumentHandler());
  registry.register(new CompleteProjectHandler());

  return registry;
}

/** URL-slug -> canonical `commandName` map, e.g. `ingest-specification` -> `IngestSpecificationCommand`. */
export function buildCommandSlugMap(registry: CommandRegistry): Map<string, string> {
  const map = new Map<string, string>();
  for (const commandName of registry.registeredCommands()) {
    map.set(slugify(commandName), commandName);
  }
  return map;
}

function slugify(commandName: string): string {
  const withoutSuffix = commandName.endsWith('Command')
    ? commandName.slice(0, -'Command'.length)
    : commandName;
  return withoutSuffix
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}
