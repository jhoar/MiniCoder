import { Command } from 'commander';
import * as fs from 'fs';
import { createDbClientFromEnv } from '../db-client.js';
import {
  TransactionalCommandExecutor,
  ImportBacklogHandler,
  parseBacklogMarkdown,
  BacklogParseError,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope } from '@minicoder/core';
import { humanActor } from '@minicoder/triggerdev';

const handler = new ImportBacklogHandler();

export function createPlanCommand(): Command {
  const plan = new Command('plan').description('Plan and backlog artifact commands');

  plan
    .command('import-backlog <file>')
    .description(
      'Parse a backlog.md file (issue #33) and import it: parse -> validate -> preview -> approve -> transactional import (docs/02 §11)',
    )
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--plan <id>', 'Implementation plan ID to import features into')
    .requiredOption('--actor <id>', 'Acting approver identity')
    .option('--actor-role <role>', 'Acting role', 'approver')
    .option(
      '--dry-run',
      'Preview only — validates and reports what would be imported, without writing',
    )
    .action(
      async (
        file: string,
        opts: { project: string; plan: string; actor: string; actorRole: string; dryRun?: boolean },
      ) => {
        const markdown = fs.readFileSync(file, 'utf-8');

        let features;
        try {
          features = parseBacklogMarkdown(markdown);
        } catch (err) {
          if (err instanceof BacklogParseError) {
            console.error(`Failed to parse ${file}: ${err.message}`);
            process.exit(1);
          }
          throw err;
        }

        const db = await createDbClientFromEnv();
        try {
          const correlationId = generateId();
          const executor = new TransactionalCommandExecutor(db);
          const envelope: CommandEnvelope<{
            projectId: string;
            planId: string;
            features: typeof features;
            dryRun: boolean;
          }> = {
            commandId: generateId(),
            idempotencyKey: `import-backlog-cli:${opts.plan}:${file}`,
            payload: {
              projectId: opts.project,
              planId: opts.plan,
              features,
              dryRun: opts.dryRun ?? false,
            },
            actor: humanActor({
              actorId: opts.actor,
              actorRole: opts.actorRole,
              correlationId,
            }),
            correlationId,
          };

          const result = await executor.execute(handler, envelope);
          console.log(
            JSON.stringify(
              {
                command: 'plan import-backlog',
                file,
                projectId: opts.project,
                planId: opts.plan,
                featureCount: features.length,
                resultingState: result.resultingState,
              },
              null,
              2,
            ),
          );
        } finally {
          await db.close();
        }
      },
    );

  return plan;
}
