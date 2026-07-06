/**
 * Re-exports from @minicoder/core — the role interfaces now live there (Phase 5).
 * packages/testing/src/adapters/* still imports from './types.js' so this shim keeps
 * existing mock implementations and scenario code unchanged.
 */
export type {
  PlannerBehavior,
  PlannerInput,
  PlannerOutput,
  PlanSectionGenerationInput,
  PlanSectionGenerationOutput,
  FeatureBacklogGenerationInput,
  GeneratedFeature,
  FeatureBacklogGenerationOutput,
  CoderBehavior,
  CoderInput,
  CoderOutput,
  ReviewerBehavior,
  ReviewerInput,
  ReviewFindingOutput,
  ReviewerOutput,
  ArbiterBehavior,
  ArbiterInput,
  ArbiterOutput,
  DocumentationBehavior,
  DocumentationInput,
  DocumentationOutput,
  HumanDecision,
  HumanApprovalInput,
  HumanApprovalOutput,
  AdapterCall,
  PlannerAgentAdapter,
  CoderAgentAdapter,
  ReviewerAgentAdapter,
  ArbiterAgentAdapter,
  DocumentationAgentAdapter,
  HumanAgentAdapter,
} from '@minicoder/core';
