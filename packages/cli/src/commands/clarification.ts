import { randomUUID } from 'crypto';
import { Command } from 'commander';
import { renderClarificationView, renderCommandResultView } from '@minicoder/tui';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

/**
 * The default (no-subcommand) invocation stays the Phase 14 read-only view; `answer` is a new
 * write action (`RecordClarificationAnswerCommand`, previously curl-only per USER-MANUAL.md §5.0
 * #2). Uses the same `isDefault`/`hidden` sibling-subcommand shape `plan.ts`/`design-doc.ts`
 * established — each subcommand independently declares its own `--project`, avoiding the
 * parent/subcommand option-collision Commander has when a flag is declared on both.
 */
export function createClarificationCommand(): Command {
  const cmd = new Command('clarification').description('Clarification sessions and questions');

  cmd
    .command('view', { isDefault: true, hidden: true })
    .description('Clarification sessions and questions (read-only — default view)')
    .requiredOption('--project <id>', 'Project ID')
    .option('--session <id>', 'Show questions for a specific clarification session')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string; session?: string } & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const [sessions, detail] = await Promise.all([
            client.listClarificationSessions(opts.project),
            opts.session
              ? client.getClarificationSession(opts.session)
              : Promise.resolve(undefined),
          ]);
          return { sessions, detail };
        },
        (data) => renderClarificationView(data),
      );
    });

  cmd
    .command('answer')
    .description(
      'Record an answer for one clarification-round question (operator+); ' +
        'expectedQuestionVersion is fetched automatically from the session',
    )
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--session <id>', 'Clarification session ID')
    .requiredOption('--question <id>', 'Clarification question ID')
    .requiredOption('--text <answer>', 'Answer text')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: {
          project: string;
          session: string;
          question: string;
          text: string;
        } & JsonOption,
      ) => {
        const client = buildApiClient();
        await renderOrJson(
          opts,
          async () => {
            const { questions } = await client.getClarificationSession(opts.session);
            const question = questions.find((q) => q.id === opts.question);
            if (!question) {
              throw new Error(
                `Question ${opts.question} not found in clarification session ${opts.session}`,
              );
            }
            const idempotencyKey = `record-clarification-answer:${opts.question}:${randomUUID()}`;
            const result = await client.recordClarificationAnswer(
              opts.question,
              opts.session,
              opts.project,
              opts.text,
              question.version,
              idempotencyKey,
            );
            return {
              command: 'record-clarification-answer',
              projectId: opts.project,
              resultingState: result.resulting_state,
            };
          },
          (data) => renderCommandResultView(data),
        );
      },
    );

  return cmd;
}
