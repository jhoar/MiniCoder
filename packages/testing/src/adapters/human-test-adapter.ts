import type {
  HumanAgentAdapter,
  HumanDecision,
  HumanApprovalInput,
  HumanApprovalOutput,
  AdapterCall,
} from './types.js';

export class HumanTestAdapterExhaustedError extends Error {
  constructor() {
    super(
      'HumanTestAdapter: decision sequence exhausted. ' +
        'Configure more decisions in the constructor to handle all expected approval requests.',
    );
    this.name = 'HumanTestAdapterExhaustedError';
  }
}

export class HumanTestAdapter implements HumanAgentAdapter {
  readonly role = 'HumanAgentAdapter' as const;
  readonly calls: AdapterCall<HumanApprovalInput, HumanApprovalOutput>[] = [];

  private readonly decisions: HumanDecision[];
  private index = 0;

  constructor(decisions: HumanDecision[] = ['approved']) {
    this.decisions = decisions;
  }

  async run(input: HumanApprovalInput): Promise<HumanApprovalOutput> {
    if (this.index >= this.decisions.length) {
      throw new HumanTestAdapterExhaustedError();
    }

    const decision = this.decisions[this.index++] as HumanDecision;
    const output: HumanApprovalOutput = {
      decision,
      notes: `HumanTestAdapter: deterministic decision ${decision} for ${input.contextType}/${input.contextId}`,
    };

    this.calls.push({ input, output, calledAt: new Date().toISOString() });
    return output;
  }

  reset(): void {
    this.index = 0;
    this.calls.length = 0;
  }
}
