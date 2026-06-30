import type {
  ReviewerAgentAdapter,
  ReviewerBehavior,
  ReviewerInput,
  ReviewerOutput,
  ReviewFindingOutput,
  AdapterCall,
} from './types.js';

const REPEATED_FINDING: ReviewFindingOutput = {
  severity: 'blocking',
  category: 'correctness',
  description: 'MockReviewerAdapter: repeated finding — missing null check in user input handler',
};

export class MockReviewerAdapter implements ReviewerAgentAdapter {
  readonly role = 'ReviewerAgentAdapter' as const;
  readonly calls: AdapterCall<ReviewerInput, ReviewerOutput>[] = [];

  constructor(public behavior: ReviewerBehavior = 'approve') {}

  async run(input: ReviewerInput): Promise<ReviewerOutput> {
    let output: ReviewerOutput;

    switch (this.behavior) {
      case 'approve':
        output = { decision: 'approved', findings: [] };
        break;

      case 'request_changes':
        output = {
          decision: 'changes_requested',
          findings: [
            {
              severity: 'blocking',
              category: 'correctness',
              description: `MockReviewerAdapter: simulated blocking finding on cycle ${input.reviewCycle}`,
            },
            {
              severity: 'non_blocking',
              category: 'style',
              description: 'MockReviewerAdapter: minor style improvement suggested',
            },
          ],
        };
        break;

      case 'repeat_finding':
        output = {
          decision: 'changes_requested',
          findings: [REPEATED_FINDING],
        };
        break;
    }

    this.calls.push({ input, output, calledAt: new Date().toISOString() });
    return output;
  }
}
