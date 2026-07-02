import { describe, it, expect } from 'vitest';
import {
  classifyCheckConclusion,
  FAILURE_CONCLUSIONS,
  NON_BLOCKING_CONCLUSIONS,
} from './check-conclusion.js';

/**
 * MEDIUM-1 code-review fix (round 5): unit tests for the shared conclusion classifier now
 * imported by both `octokit-client.ts`'s `deriveCiStatus` and `normalize.ts`'s
 * `check_run`/`check_suite` webhook normalization, eliminating the prior duplicated (and
 * drifted-apart) classification logic between the two files.
 */
describe('classifyCheckConclusion', () => {
  it('classifies null (no conclusion yet — still pending/in-progress) as unknown', () => {
    expect(classifyCheckConclusion(null)).toBe('unknown');
  });

  it('classifies success as passed', () => {
    expect(classifyCheckConclusion('success')).toBe('passed');
  });

  for (const conclusion of NON_BLOCKING_CONCLUSIONS) {
    it(`classifies non-blocking conclusion '${conclusion}' as passed`, () => {
      expect(classifyCheckConclusion(conclusion)).toBe('passed');
    });
  }

  for (const conclusion of FAILURE_CONCLUSIONS) {
    it(`classifies failure conclusion '${conclusion}' as failed`, () => {
      expect(classifyCheckConclusion(conclusion)).toBe('failed');
    });
  }

  it('classifies an unrecognized conclusion string as unknown', () => {
    expect(classifyCheckConclusion('some_future_conclusion_github_has_not_invented_yet')).toBe(
      'unknown',
    );
  });
});
