import { describe, it, expect } from 'vitest';
import { GenericLLMPlannerAdapter } from './generic-llm-planner-adapter.js';
import type { PlanProvider } from './plan-provider.js';

function stubProvider(overrides: Partial<PlanProvider> = {}): PlanProvider {
  return {
    assessReadiness: async () => ({
      readinessResult: 'sufficient',
      questions: [],
      assumptions: [],
      gaps: [],
    }),
    generatePlanSections: async () => ({
      title: 'Plan',
      sections: [{ title: 'Overview', content: 'Content.' }],
    }),
    generateFeatureBacklog: async () => ({
      features: [
        {
          frId: 'FR-001',
          title: 'Add widget',
          description: 'A widget.',
          kind: 'feature',
          priority: 0,
          dependsOnFrIds: [],
          acceptanceCriteria: ['Criteria.'],
          testExpectations: [{ description: 'Covered.', testType: 'unit' }],
        },
      ],
    }),
    ...overrides,
  };
}

describe('GenericLLMPlannerAdapter', () => {
  it('run() delegates to PlanProvider.assessReadiness', async () => {
    const adapter = new GenericLLMPlannerAdapter({ planProvider: stubProvider() });
    const result = await adapter.run({
      projectId: 'proj-1',
      specificationContent: 'Build a widget.',
      correlationId: 'corr-1',
    });
    expect(result.readinessResult).toBe('sufficient');
  });

  it('generatePlanSections() delegates to PlanProvider.generatePlanSections', async () => {
    const adapter = new GenericLLMPlannerAdapter({ planProvider: stubProvider() });
    const result = await adapter.generatePlanSections({
      projectId: 'proj-1',
      assessmentId: 'assess-1',
      specificationContent: 'Build a widget.',
      correlationId: 'corr-1',
    });
    expect(result.title).toBe('Plan');
    expect(result.sections).toEqual([{ title: 'Overview', content: 'Content.' }]);
  });

  it('generateFeatureBacklog() delegates to PlanProvider.generateFeatureBacklog', async () => {
    const adapter = new GenericLLMPlannerAdapter({ planProvider: stubProvider() });
    const result = await adapter.generateFeatureBacklog({
      projectId: 'proj-1',
      planId: 'plan-1',
      planSections: [{ title: 'Overview', content: 'Content.' }],
      correlationId: 'corr-1',
    });
    expect(result.features).toHaveLength(1);
    expect(result.features[0]).toMatchObject({ frId: 'FR-001', kind: 'feature' });
  });
});
