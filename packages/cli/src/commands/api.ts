import { Command } from 'commander';
import { serve } from '@minicoder/api';

/**
 * `minicoder api serve` — starts the Orchestrator API (Phase 13), mirroring
 * `minicoder github serve`'s shape. Unlike `minicoder github serve`, the process stays alive
 * serving the full read/command/webhook surface, not just the GitHub webhook route.
 */
export function createApiCommand(): Command {
  const api = new Command('api').description('Orchestrator API commands (docs/06 Phase 13)');

  api
    .command('serve')
    .description('Start the Orchestrator API (read/command/webhook endpoints)')
    .option('--port <number>', 'Port to listen on', (v) => parseInt(v, 10), 4000)
    .option('--host <host>', 'Host to bind to', '0.0.0.0')
    .action(async (opts: { port: number; host: string }) => {
      try {
        const address = await serve({ port: opts.port, host: opts.host });
        console.log(`minicoder Orchestrator API listening at ${address}`);
      } catch (err) {
        console.error('Error: failed to start Orchestrator API:', err);
        process.exit(1);
      }
      // `serve()` itself registers SIGINT/SIGTERM handlers that close the DB connection (and
      // checkpoint SQLite's WAL) before exiting — see `packages/api/src/server.ts`.
    });

  return api;
}
