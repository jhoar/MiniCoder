export const ALL_TASK_IDS = [
  'planning-readiness-assessment',
  'start-clarification',
  'generate-implementation-plan',
  'generate-feature-backlog',
  'activate-approved-backlog',
  'start-next-feature',
  'github-reconciliation',
  'export-plan',
  'export-backlog',
] as const;

export type TaskId = (typeof ALL_TASK_IDS)[number];
