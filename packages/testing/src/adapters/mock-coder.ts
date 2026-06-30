import type {
  CoderAgentAdapter,
  CoderBehavior,
  CoderInput,
  CoderOutput,
  AdapterCall,
} from './types.js';

export class MockCoderError extends Error {
  constructor(
    public readonly code: 'timeout' | 'rate_limited' | 'invalid_output' | 'provider_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'MockCoderError';
  }
}

export class MockCoderAdapter implements CoderAgentAdapter {
  readonly role = 'CoderAgentAdapter' as const;
  readonly calls: AdapterCall<CoderInput, CoderOutput | null>[] = [];

  constructor(public behavior: CoderBehavior = 'success') {}

  async run(input: CoderInput): Promise<CoderOutput> {
    if (this.behavior === 'fail') {
      this.calls.push({ input, output: null, calledAt: new Date().toISOString() });
      throw new MockCoderError('provider_unavailable', 'MockCoderAdapter: simulated failure');
    }

    if (this.behavior === 'invalid_output') {
      this.calls.push({ input, output: null, calledAt: new Date().toISOString() });
      throw new MockCoderError('invalid_output', 'MockCoderAdapter: simulated invalid output');
    }

    const output: CoderOutput = {
      commitSha: `mock-sha-${input.featureRunId.slice(-8)}-${this.calls.length + 1}`,
      branchName: `minicoder/${input.featureRunId}`,
      filesChanged: 3,
    };

    this.calls.push({ input, output, calledAt: new Date().toISOString() });
    return output;
  }
}
