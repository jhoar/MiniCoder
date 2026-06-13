import type { CommandHandler } from './types.js';

export class CommandRegistry {
  private readonly handlers = new Map<string, CommandHandler<unknown, string>>();

  register<P, S extends string>(handler: CommandHandler<P, S>): void {
    if (this.handlers.has(handler.commandName)) {
      throw new Error(`Command handler already registered: ${handler.commandName}`);
    }
    this.handlers.set(handler.commandName, handler as CommandHandler<unknown, string>);
  }

  get<P, S extends string>(commandName: string): CommandHandler<P, S> | undefined {
    return this.handlers.get(commandName) as CommandHandler<P, S> | undefined;
  }

  has(commandName: string): boolean {
    return this.handlers.has(commandName);
  }

  registeredCommands(): readonly string[] {
    return Array.from(this.handlers.keys());
  }
}
