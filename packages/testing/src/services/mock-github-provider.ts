export interface MockPrState {
  prNumber: number;
  featureRunId: string | null;
  headSha: string;
  state: 'open' | 'closed' | 'merged';
  reviews: Array<{ reviewer: string; state: 'approved' | 'changes_requested' }>;
  checks: Array<{ id: string; state: 'passed' | 'failed' }>;
  mergedAt: string | null;
  mergeSha: string | null;
  /** Phase 12 (Merge Gate) test seam: when set, `MockGitHubClient.mergePullRequest` throws a
   * `GithubMergeRejectedError` classified by this reason instead of succeeding — see
   * `simulateMergeConflict`. */
  mergeShouldFail: 'sha_mismatch' | 'not_mergeable' | null;
}

export interface SimulatedEvent {
  type: string;
  prNumber: number;
  payload: Record<string, unknown>;
  simulatedAt: string;
}

export class MockGitHubProvider {
  private readonly prs = new Map<number, MockPrState>();
  readonly events: SimulatedEvent[] = [];

  simulatePrOpened(prNumber: number, featureRunId: string, headSha: string): void {
    this.prs.set(prNumber, {
      prNumber,
      featureRunId,
      headSha,
      state: 'open',
      reviews: [],
      checks: [],
      mergedAt: null,
      mergeSha: null,
      mergeShouldFail: null,
    });
    this.recordEvent('pull_request.opened', prNumber, { featureRunId, headSha });
  }

  /** Phase 12 test seam: makes the next `MockGitHubClient.mergePullRequest` call for this PR
   * throw a classified `GithubMergeRejectedError` instead of succeeding. */
  simulateMergeConflict(prNumber: number, reason: 'sha_mismatch' | 'not_mergeable'): void {
    const pr = this.requirePr(prNumber);
    pr.mergeShouldFail = reason;
  }

  simulatePrSynchronized(prNumber: number, headSha: string): void {
    const pr = this.requirePr(prNumber);
    pr.headSha = headSha;
    pr.checks = [];
    this.recordEvent('pull_request.synchronize', prNumber, { headSha });
  }

  simulateCheckPassed(prNumber: number, checkRunId: string): void {
    const pr = this.requirePr(prNumber);
    const existing = pr.checks.find((c) => c.id === checkRunId);
    if (existing) {
      existing.state = 'passed';
    } else {
      pr.checks.push({ id: checkRunId, state: 'passed' });
    }
    this.recordEvent('check_run.completed', prNumber, { checkRunId, conclusion: 'success' });
  }

  simulateCheckFailed(prNumber: number, checkRunId: string): void {
    const pr = this.requirePr(prNumber);
    const existing = pr.checks.find((c) => c.id === checkRunId);
    if (existing) {
      existing.state = 'failed';
    } else {
      pr.checks.push({ id: checkRunId, state: 'failed' });
    }
    this.recordEvent('check_run.completed', prNumber, { checkRunId, conclusion: 'failure' });
  }

  simulateReviewApproved(prNumber: number, reviewer: string): void {
    const pr = this.requirePr(prNumber);
    const existing = pr.reviews.find((r) => r.reviewer === reviewer);
    if (existing) {
      existing.state = 'approved';
    } else {
      pr.reviews.push({ reviewer, state: 'approved' });
    }
    this.recordEvent('pull_request_review.submitted', prNumber, {
      reviewer,
      state: 'approved',
    });
  }

  simulateReviewRequestedChanges(
    prNumber: number,
    reviewer: string,
    findings: string[] = [],
  ): void {
    const pr = this.requirePr(prNumber);
    const existing = pr.reviews.find((r) => r.reviewer === reviewer);
    if (existing) {
      existing.state = 'changes_requested';
    } else {
      pr.reviews.push({ reviewer, state: 'changes_requested' });
    }
    this.recordEvent('pull_request_review.submitted', prNumber, {
      reviewer,
      state: 'changes_requested',
      findings,
    });
  }

  simulatePrMerged(prNumber: number, mergeSha: string): void {
    const pr = this.requirePr(prNumber);
    pr.state = 'merged';
    pr.mergedAt = new Date().toISOString();
    pr.mergeSha = mergeSha;
    this.recordEvent('pull_request.closed', prNumber, { merged: true, mergeSha });
  }

  simulatePrClosed(prNumber: number): void {
    const pr = this.requirePr(prNumber);
    pr.state = 'closed';
    this.recordEvent('pull_request.closed', prNumber, { merged: false });
  }

  getPrState(prNumber: number): MockPrState | undefined {
    return this.prs.get(prNumber);
  }

  allPrs(): MockPrState[] {
    return Array.from(this.prs.values());
  }

  reset(): void {
    this.prs.clear();
    this.events.length = 0;
  }

  private requirePr(prNumber: number): MockPrState {
    const pr = this.prs.get(prNumber);
    if (!pr)
      throw new Error(`MockGitHubProvider: PR #${prNumber} not found (simulate-pr-opened first)`);
    return pr;
  }

  private recordEvent(type: string, prNumber: number, payload: Record<string, unknown>): void {
    this.events.push({ type, prNumber, payload, simulatedAt: new Date().toISOString() });
  }
}
