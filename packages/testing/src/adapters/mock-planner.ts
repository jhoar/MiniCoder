import type {
  PlannerAgentAdapter,
  PlannerBehavior,
  PlannerInput,
  PlannerOutput,
  AdapterCall,
} from './types.js';

export class MockPlannerAdapter implements PlannerAgentAdapter {
  readonly role = 'PlannerAgentAdapter' as const;
  readonly calls: AdapterCall<PlannerInput, PlannerOutput>[] = [];

  constructor(public behavior: PlannerBehavior = 'sufficient') {}

  async run(input: PlannerInput): Promise<PlannerOutput> {
    let output: PlannerOutput;

    switch (this.behavior) {
      case 'sufficient':
        output = {
          readinessResult: 'sufficient',
          questions: [],
          assumptions: [],
          gaps: [],
        };
        break;

      case 'sufficient_with_assumptions':
        output = {
          readinessResult: 'sufficient_with_assumptions',
          questions: [],
          assumptions: [
            {
              description: 'Assuming standard REST API patterns apply',
              confidence: 'high',
            },
            {
              description: 'Assuming PostgreSQL is the production database',
              confidence: 'medium',
            },
          ],
          gaps: [],
        };
        break;

      case 'insufficient':
        output = {
          readinessResult: 'insufficient',
          questions: [
            { question: 'What is the expected user volume?', round: 1 },
            { question: 'What authentication method should be used?', round: 1 },
          ],
          assumptions: [],
          gaps: [
            {
              description: 'Missing non-functional requirements (performance, scalability)',
              severity: 'blocking',
            },
          ],
        };
        break;
    }

    this.calls.push({ input, output, calledAt: new Date().toISOString() });
    return output;
  }
}
