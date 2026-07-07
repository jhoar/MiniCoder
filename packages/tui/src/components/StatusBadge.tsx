import React from 'react';
import { Text } from 'ink';

const GOOD_STATES = new Set([
  'running',
  'active',
  'merged',
  'succeeded',
  'approved',
  'approved_by_policy',
  'merge_ready',
  'valid',
  'resolved',
]);
const BAD_STATES = new Set([
  'failed',
  'human_required',
  'blocked',
  'ci_failed',
  'merge_failed',
  'system_failed',
  'paused_budget_exceeded',
  'skipped',
  'changes_requested',
  'escalated',
]);
const NEUTRAL_STATES = new Set(['paused_by_operator', 'waiting_for_budget_approval', 'pending']);

/** Colors a known state token green/red/yellow by category — a small, hand-rolled affordance
 * since this repo has no existing terminal-color convention to reuse (Phase 14 is the first). */
export function StatusBadge({ state }: { state: string }): React.ReactElement {
  const color = GOOD_STATES.has(state)
    ? 'green'
    : BAD_STATES.has(state)
      ? 'red'
      : NEUTRAL_STATES.has(state)
        ? 'yellow'
        : undefined;
  return (
    <Text color={color} wrap="truncate-end">
      {state}
    </Text>
  );
}
