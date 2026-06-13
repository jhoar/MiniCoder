#!/usr/bin/env tsx
import { Command } from 'commander';
import { createDbCommand } from './commands/db.js';
import { createStateCommand } from './commands/state.js';

const program = new Command();

program
  .name('minicoder')
  .description('MiniCoder — Agentic Software Development Orchestration System')
  .version('0.1.0');

program.addCommand(createDbCommand());
program.addCommand(createStateCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
