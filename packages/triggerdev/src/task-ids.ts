export const ALL_TASK_IDS = [
  'ingest-specification',
  'planning-readiness-assessment',
  'start-clarification',
  'record-clarification-answer',
  'complete-clarification',
  'generate-implementation-plan',
  'generate-feature-backlog',
  'validate-backlog',
  'request-plan-approval',
  'activate-approved-backlog',
  'start-next-feature',
  'run-coder',
  'run-review',
  'run-merge-gate',
  'github-reconciliation',
  'export-plan',
  'export-backlog',
  'import-backlog',
  'run-design-doc',
] as const;

export type TaskId = (typeof ALL_TASK_IDS)[number];
