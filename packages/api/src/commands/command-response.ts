import type { CommandResult } from '@minicoder/core';

/** docs/01-system-specification.md §9's command envelope response shape (snake_case over HTTP). */
export interface CommandEnvelopeResponse {
  command_id: string;
  accepted: boolean;
  resulting_state: string;
  emitted_event_ids: readonly string[];
}

export function toCommandEnvelopeResponse(result: CommandResult): CommandEnvelopeResponse {
  return {
    command_id: result.commandId,
    accepted: result.accepted,
    resulting_state: result.resultingState,
    emitted_event_ids: result.emittedEventIds,
  };
}
