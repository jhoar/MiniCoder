import type { DbClient } from '@minicoder/core';

export type FixtureName =
  | 'planning-basic'
  | 'planning-review-merge'
  | 'clarification-required'
  | 'backlog-activation'
  | 'review-loop'
  | 'merge-gate'
  | 'trigger-retry'
  | 'github-race'
  | 'final-design-document'
  | 'execution-orchestrator'
  | 'coder-adapter-run'
  | 'review-fix-loop'
  | 'disagreement-arbiter'
  | 'design-document-lifecycle';

export interface Fixture {
  name: FixtureName;
  description: string;
  setup(db: DbClient, projectId?: string): Promise<void>;
}
