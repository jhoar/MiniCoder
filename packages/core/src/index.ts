export * from './persistence/types.js';
export * from './persistence/optimistic.js';
export * from './config/secrets.js';
export * from './config/config.js';
export * from './domain/states.js';
export * from './domain/entities.js';

// Phase 2: auth
export * from './auth/types.js';
export * from './auth/guards.js';
export * from './auth/local-auth.js';
export * from './auth/redaction.js';

// Phase 2: state machine
export * from './statemachine/types.js';
export * from './statemachine/validator.js';
export * from './statemachine/machines/feature-execution.js';
export * from './statemachine/machines/plan-lifecycle.js';
export * from './statemachine/machines/project-lifecycle.js';
export * from './statemachine/machines/automation-control.js';
export * from './statemachine/machines/agent-run.js';
export * from './statemachine/machines/workflow-run.js';
export * from './statemachine/machines/clarification.js';
export * from './statemachine/machines/artifact-export.js';

// Phase 2: commands
export * from './commands/types.js';
export * from './commands/registry.js';
export * from './commands/executor.js';
export * from './commands/helpers.js';

// Phase 2: events
export * from './events/schemas.js';

// Phase 5: agent adapters
export * from './adapters/types.js';
export * from './adapters/capabilities.js';
export * from './adapters/registry.js';
export * from './adapters/run-recorder.js';

// Phase 6: planning / clarification command handlers
export * from './commands/handlers/planning/ingest-specification.js';
export * from './commands/handlers/planning/assess-planning-readiness.js';
export * from './commands/handlers/planning/generate-implementation-plan.js';
export * from './commands/handlers/planning/generate-feature-backlog.js';
export * from './commands/handlers/planning/validate-backlog.js';
export * from './commands/handlers/planning/submit-plan-for-approval.js';
export * from './commands/handlers/planning/activate-plan.js';
export * from './commands/handlers/planning/export-plan.js';
export * from './commands/handlers/planning/export-backlog.js';
export * from './commands/handlers/planning/import-backlog.js';
export * from './commands/handlers/clarification/start-clarification.js';
export * from './commands/handlers/clarification/record-clarification-answer.js';
export * from './commands/handlers/clarification/complete-clarification.js';
export * from './commands/handlers/clarification/request-another-clarification-round.js';
export * from './commands/handlers/clarification/block-clarification.js';

// Phase 7: GitHub webhooks, integration, and reconciliation
export * from './github/client.js';
export * from './github/reconcile.js';
export * from './commands/handlers/feature/escalate-to-human-required.js';
export * from './commands/handlers/github/record-pr-opened.js';
export * from './commands/handlers/github/record-ci-running.js';
export * from './commands/handlers/github/record-ci-passed.js';
export * from './commands/handlers/github/record-ci-failed.js';
export * from './commands/handlers/github/record-changes-requested.js';
export {
  getPullRequestByFeatureRun,
  insertPullRequestRow,
  syncPullRequestObservedState,
  labelsEqual,
  timestampsEqual,
  type PullRequestRow,
} from './commands/handlers/github/pull-request-row.js';

// Phase 8: Execution Orchestrator
export * from './commands/handlers/feature/select-feature.js';
export * from './commands/handlers/feature/start-coding.js';
export * from './commands/handlers/feature/record-code-pushed.js';
export * from './commands/handlers/feature/start-fixing.js';
export * from './commands/handlers/feature/unblock-feature.js';
export * from './commands/handlers/feature/find-next-eligible-feature.js';
export * from './commands/handlers/automation/pause-automation.js';
export * from './commands/handlers/automation/resume-automation.js';
export * from './commands/handlers/automation/record-budget-exceeded.js';
export * from './commands/handlers/automation/record-budget-approval-waiting.js';
export * from './commands/handlers/automation/approve-budget-override.js';
export * from './cost/budget-evaluator.js';
export * from './cost/apply-budget-decision.js';
export * from './domain/constants.js';

// Phase 10: Reference Reviewer Adapter and Review/Fix Loop
export * from './review/index.js';
export * from './commands/handlers/github/request-changes-after-ci-fail.js';

// Phase 11: Disagreement, Arbiter, and Human Escalation
export * from './disagreement/index.js';
export * from './commands/handlers/feature/resolve-disagreement.js';
export * from './commands/handlers/feature/resume-feature-execution.js';
export * from './commands/handlers/feature/retry-feature.js';
export * from './commands/handlers/feature/skip-feature.js';
export * from './commands/handlers/feature/block-feature.js';

// Phase 12: Merge Gate and Branch Protection
export * from './merge-gate/index.js';
export * from './commands/handlers/feature/record-approved-by-policy.js';
export * from './commands/handlers/feature/merge-if-ready.js';
export * from './commands/handlers/feature/record-merged.js';
export * from './commands/handlers/feature/record-merge-failed.js';
export * from './commands/handlers/feature/reconcile-merge-failed.js';
