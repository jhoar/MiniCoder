#!/usr/bin/env tsx
import { Command } from 'commander';
import { createDbCommand } from './commands/db.js';
import { createStateCommand } from './commands/state.js';
import { createTriggerCommand } from './commands/trigger.js';
import { createGithubCommand } from './commands/github.js';
import { createGiteaCommand } from './commands/gitea.js';
import { createGitlabCommand } from './commands/gitlab.js';
import { createTestCommand } from './commands/test.js';
import { createHumanCommand } from './commands/human.js';
import { createMergeCommand } from './commands/merge.js';
import { createApiCommand } from './commands/api.js';
import { createPlanCommand } from './commands/plan.js';
import { createStatusCommand } from './commands/status.js';
import { createClarificationCommand } from './commands/clarification.js';
import { createFeaturesCommand } from './commands/features.js';
import { createActiveCommand } from './commands/active.js';
import { createRunsCommand } from './commands/runs.js';
import { createFindingsCommand } from './commands/findings.js';
import { createDisagreementsCommand } from './commands/disagreements.js';
import { createCostsCommand } from './commands/costs.js';
import { createArtifactsCommand } from './commands/artifacts.js';
import { createAdaptersCommand } from './commands/adapters.js';
import { createDesignDocCommand } from './commands/design-doc.js';
import { createPauseCommand } from './commands/pause.js';
import { createResumeCommand } from './commands/resume.js';
import { createProjectCommand } from './commands/project.js';
import { createObservabilityCommand } from './commands/observability.js';
import { createTasksCommand } from './commands/tasks.js';
import { createSpecCommand } from './commands/spec.js';
import { createBudgetCommand } from './commands/budget.js';
import { createRunCommand } from './commands/run.js';

const program = new Command();

program
  .name('minicoder')
  .description('MiniCoder — Agentic Software Development Orchestration System')
  .version('0.1.0');

program.addCommand(createDbCommand());
program.addCommand(createStateCommand());
program.addCommand(createTriggerCommand());
program.addCommand(createGithubCommand());
program.addCommand(createGiteaCommand());
program.addCommand(createGitlabCommand());
program.addCommand(createTestCommand());
program.addCommand(createHumanCommand());
program.addCommand(createMergeCommand());
program.addCommand(createApiCommand());
program.addCommand(createPlanCommand());
program.addCommand(createStatusCommand());
program.addCommand(createClarificationCommand());
program.addCommand(createFeaturesCommand());
program.addCommand(createActiveCommand());
program.addCommand(createRunsCommand());
program.addCommand(createFindingsCommand());
program.addCommand(createDisagreementsCommand());
program.addCommand(createCostsCommand());
program.addCommand(createArtifactsCommand());
program.addCommand(createAdaptersCommand());
program.addCommand(createDesignDocCommand());
program.addCommand(createPauseCommand());
program.addCommand(createResumeCommand());
program.addCommand(createProjectCommand());
program.addCommand(createObservabilityCommand());
program.addCommand(createTasksCommand());
program.addCommand(createSpecCommand());
program.addCommand(createBudgetCommand());
program.addCommand(createRunCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
