import type {
  ArbiterAgentAdapter,
  ArbiterBehavior,
  ArbiterInput,
  ArbiterOutput,
  AdapterCall,
} from './types.js';

export class MockArbiterAdapter implements ArbiterAgentAdapter {
  readonly role = 'ArbiterAgentAdapter' as const;
  readonly calls: AdapterCall<ArbiterInput, ArbiterOutput>[] = [];

  constructor(public behavior: ArbiterBehavior = 'resolve') {}

  async run(input: ArbiterInput): Promise<ArbiterOutput> {
    const output: ArbiterOutput =
      this.behavior === 'resolve'
        ? {
            resolution: 'reviewer_correct',
            notes: 'MockArbiterAdapter: reviewer finding is valid; coder must address it',
          }
        : {
            resolution: 'escalate_to_human',
            notes: 'MockArbiterAdapter: disagreement exceeds automation scope; escalating',
          };

    this.calls.push({ input, output, calledAt: new Date().toISOString() });
    return output;
  }
}
