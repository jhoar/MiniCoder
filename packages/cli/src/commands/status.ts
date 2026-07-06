import { Command } from 'commander';
import { ApiError, renderStatusView } from '@minicoder/tui';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createStatusCommand(): Command {
  return new Command('status')
    .description(
      'Project status dashboard: project/automation state, Workflow Layer runs, state health',
    )
    .requiredOption('--project <id>', 'Project ID')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string } & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const [status, whoami, triggerdevRuns] = await Promise.all([
            client.getStatus(opts.project),
            client.getWhoami(),
            client.listTriggerdevRuns({ projectId: opts.project }, { limit: '20' }),
          ]);
          let doctor;
          try {
            doctor = await client.getDoctorStatus(opts.project);
          } catch (err) {
            // A viewer-role key can't call the operator-gated /commands/doctor route — the
            // Orchestrator API enforces this, not the TUI, so this section is simply omitted
            // rather than failing the whole command (see CLAUDE.md's Ink Text UI constraints).
            if (!(err instanceof ApiError) || err.status !== 403) throw err;
          }
          return { status, whoami, triggerdevRuns, doctor };
        },
        (data) => renderStatusView(data),
      );
    });
}
