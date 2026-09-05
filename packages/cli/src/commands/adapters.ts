import { Command } from 'commander';
import { renderAdaptersView, renderCommandResultView } from '@minicoder/tui/views';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

/**
 * `adapters` (bare) shows the read-only registered-adapters view (unchanged from before); `adapter
 * register` (issue found while testing the planning pipeline end to end) is the missing
 * counterpart — `AdapterRegistry.register()` existed since Phase 1 but had no CLI/API surface at
 * all, so every adapter-backed task (planning readiness, coder, reviewer, arbiter, design-doc) was
 * unreachable in a real deployment: nothing could create the `agent_adapters` row those tasks
 * resolve by role+name. Deliberately named `adapter` (singular) for the write subcommand rather
 * than adding it under `adapters` (plural) — matching the reader's expectation that a plural
 * top-level noun stays read-only, the same convention `plan`/`design-doc` already establish for
 * their own read-vs-write split.
 *
 * `view` uses the same `isDefault`/`hidden` shape `plan.ts`/`design-doc.ts` already establish for
 * avoiding Commander's parent/subcommand flag-collision gotcha (a flag declared on both the parent
 * Command and one of its subcommands binds to the parent, starving the subcommand's own check) —
 * applied here for consistency even though `adapters`' own `--adapter` flag is optional, not
 * required, and so wasn't actually at risk.
 */
export function createAdaptersCommand(): Command {
  const cmd = new Command('adapters').description(
    'Registered agent adapters and their configurations',
  );

  cmd
    .command('view', { isDefault: true, hidden: true })
    .description('Default registered-adapters view')
    .option('--adapter <id>', 'Show configurations for a specific adapter only')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { adapter?: string } & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const [adapters, configurations] = await Promise.all([
            client.listAgentAdapters(),
            client.listAgentConfigurations(opts.adapter),
          ]);
          return { adapters, configurations };
        },
        (data) => renderAdaptersView(data),
      );
    });

  return cmd;
}

export function createAdapterCommand(): Command {
  const cmd = new Command('adapter').description('Agent adapter registration (operator+)');

  cmd
    .command('register')
    .description(
      'Registers (or updates) an agent adapter — required before any task using that ' +
        'role/name (planning readiness, coder, reviewer, arbiter, design-doc) can run',
    )
    .requiredOption(
      '--role <role>',
      'PlannerAgentAdapter | CoderAgentAdapter | ReviewerAgentAdapter | ArbiterAgentAdapter | ' +
        'DocumentationAgentAdapter | HumanAgentAdapter',
    )
    .requiredOption('--name <name>', 'Registry name (e.g. GenericLLMPlannerAdapter)')
    .requiredOption('--implementation <impl>', 'Implementation identifier/version string')
    .requiredOption(
      '--capabilities <tokens>',
      'Comma-separated capability tokens (docs/03 §3), e.g. can_generate_plan',
    )
    .option('--inactive', 'Register as inactive (default: active)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (opts: {
        role: string;
        name: string;
        implementation: string;
        capabilities: string;
        inactive?: boolean;
      } & JsonOption) => {
        const client = buildApiClient();
        await renderOrJson(
          opts,
          () =>
            client.registerAdapter(
              opts.role,
              opts.name,
              opts.implementation,
              opts.capabilities.split(',').map((t) => t.trim()).filter(Boolean),
              !opts.inactive,
            ),
          (data) =>
            renderCommandResultView({
              command: 'register-adapter',
              projectId: '(none)',
              resultingState: `${data.role}/${data.name}`,
            }),
        );
      },
    );

  return cmd;
}
