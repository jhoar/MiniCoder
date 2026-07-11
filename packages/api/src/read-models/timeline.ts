/**
 * Workflow timeline / agent-run trace view (Phase 16, docs/01 §5.12 Observability). Reconstructs
 * a single feature run's full chronological history by merging several independently-queried,
 * `feature_run_id`-scoped tables into one ordered timeline — `workflow_events`, `agent_runs`
 * (with their `agent_tool_operations`), `review_findings`, `coder_responses`, the `pull_requests`
 * mirror row, `cost_records`, and `human_approvals`.
 *
 * Each source table is queried independently and merged/sorted in application code, rather than
 * one large JOIN — the same "two-step queries, not an ambiguous JOIN" posture
 * `listHumanRequiredItems()` already established (CLAUDE.md's Ink Text UI Operational
 * Constraints), generalized here to seven source tables instead of two. A single JOIN across
 * this many tables carrying independent `id`/`created_at` columns would multiply rows
 * (fan-out) and reintroduce exactly the bare-column-ambiguity problem that pattern exists to
 * avoid — merging pre-aggregated, already-scoped result sets is both simpler and correct.
 */
import type { DbClient } from '@minicoder/core';

export type TimelineEntryKind =
  | 'workflow_event'
  | 'agent_run'
  | 'tool_operation'
  | 'review_finding'
  | 'coder_response'
  | 'pull_request'
  | 'cost_record'
  | 'human_approval';

export interface TimelineEntry {
  timestamp: string;
  kind: TimelineEntryKind;
  summary: string;
  data: Record<string, unknown>;
}

export interface FeatureRunTimeline {
  featureRunId: string;
  entries: TimelineEntry[];
}

export async function getFeatureRunTimeline(
  db: DbClient,
  featureRunId: string,
): Promise<FeatureRunTimeline> {
  const entries: TimelineEntry[] = [];

  const workflowEvents = await db.query<{
    id: string;
    event_type: string;
    from_state: string | null;
    to_state: string | null;
    actor: string | null;
    occurred_at: string;
  }>(
    `SELECT id, event_type, from_state, to_state, actor, occurred_at
     FROM workflow_events WHERE feature_run_id = ? ORDER BY occurred_at ASC, id ASC`,
    [featureRunId],
  );
  for (const row of workflowEvents) {
    entries.push({
      timestamp: row.occurred_at,
      kind: 'workflow_event',
      summary: row.from_state
        ? `${row.event_type}: ${row.from_state} -> ${row.to_state ?? '?'}`
        : row.event_type,
      data: row,
    });
  }

  const agentRuns = await db.query<{
    id: string;
    role: string;
    state: string;
    adapter_name: string | null;
    provider: string | null;
    model: string | null;
    tokens_used: number | null;
    cost_usd: number | null;
    started_at: string | null;
    ended_at: string | null;
    created_at: string;
  }>(
    `SELECT id, role, state, adapter_name, provider, model, tokens_used, cost_usd, started_at, ended_at, created_at
     FROM agent_runs WHERE feature_run_id = ? ORDER BY created_at ASC, id ASC`,
    [featureRunId],
  );
  for (const row of agentRuns) {
    entries.push({
      timestamp: row.started_at ?? row.created_at,
      kind: 'agent_run',
      summary: `${row.role} run ${row.state}${row.adapter_name ? ` (${row.adapter_name})` : ''}`,
      data: row,
    });
  }

  const agentRunIds = agentRuns.map((r) => r.id);
  if (agentRunIds.length > 0) {
    const placeholders = agentRunIds.map(() => '?').join(', ');
    const toolOps = await db.query<{
      id: string;
      agent_run_id: string;
      tool_name: string;
      status: string;
      duration_ms: number | null;
      occurred_at: string;
    }>(
      `SELECT id, agent_run_id, tool_name, status, duration_ms, occurred_at
       FROM agent_tool_operations WHERE agent_run_id IN (${placeholders}) ORDER BY occurred_at ASC, id ASC`,
      agentRunIds,
    );
    for (const row of toolOps) {
      entries.push({
        timestamp: row.occurred_at,
        kind: 'tool_operation',
        summary: `tool ${row.tool_name} ${row.status}`,
        data: row,
      });
    }
  }

  const findings = await db.query<{
    id: string;
    review_cycle: number;
    severity: string;
    description: string;
    resolved: number | boolean;
    created_at: string;
  }>(
    `SELECT id, review_cycle, severity, description, resolved, created_at
     FROM review_findings WHERE feature_run_id = ? ORDER BY created_at ASC, id ASC`,
    [featureRunId],
  );
  for (const row of findings) {
    entries.push({
      timestamp: row.created_at,
      kind: 'review_finding',
      summary: `finding (cycle ${row.review_cycle}, ${row.severity}): ${row.description.slice(0, 120)}`,
      data: row,
    });
  }

  const findingIds = findings.map((f) => f.id);
  if (findingIds.length > 0) {
    const placeholders = findingIds.map(() => '?').join(', ');
    const responses = await db.query<{
      id: string;
      finding_id: string;
      response_type: string;
      created_at: string;
    }>(
      `SELECT id, finding_id, response_type, created_at
       FROM coder_responses WHERE finding_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
      findingIds,
    );
    for (const row of responses) {
      entries.push({
        timestamp: row.created_at,
        kind: 'coder_response',
        summary: `coder response: ${row.response_type}`,
        data: row,
      });
    }
  }

  const pullRequests = await db.query<{
    id: string;
    pr_number: number;
    state: string;
    review_state: string;
    ci_status: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, pr_number, state, review_state, ci_status, created_at, updated_at
     FROM pull_requests WHERE feature_run_id = ?`,
    [featureRunId],
  );
  for (const row of pullRequests) {
    entries.push({
      timestamp: row.created_at,
      kind: 'pull_request',
      summary: `PR #${row.pr_number} opened (${row.state})`,
      data: row,
    });
    if (row.updated_at !== row.created_at) {
      entries.push({
        timestamp: row.updated_at,
        kind: 'pull_request',
        summary: `PR #${row.pr_number} last observed: state=${row.state} review=${row.review_state} ci=${row.ci_status}`,
        data: row,
      });
    }
  }

  const costRecords = await db.query<{
    id: string;
    amount: number;
    currency: string;
    provider: string | null;
    model: string | null;
    recorded_at: string;
  }>(
    `SELECT id, amount, currency, provider, model, recorded_at
     FROM cost_records WHERE feature_run_id = ? ORDER BY recorded_at ASC, id ASC`,
    [featureRunId],
  );
  for (const row of costRecords) {
    entries.push({
      timestamp: row.recorded_at,
      kind: 'cost_record',
      summary: `cost ${row.amount} ${row.currency}${row.provider ? ` (${row.provider}/${row.model ?? '?'})` : ''}`,
      data: row,
    });
  }

  const approvals = await db.query<{
    id: string;
    context_type: string;
    decision: string | null;
    actor: string;
    decided_at: string | null;
    created_at: string;
  }>(
    `SELECT id, context_type, decision, actor, decided_at, created_at
     FROM human_approvals WHERE feature_run_id = ? ORDER BY created_at ASC, id ASC`,
    [featureRunId],
  );
  for (const row of approvals) {
    entries.push({
      timestamp: row.decided_at ?? row.created_at,
      kind: 'human_approval',
      summary: `human approval (${row.context_type}): ${row.decision ?? 'pending'} by ${row.actor}`,
      data: row,
    });
  }

  entries.sort((a, b) => {
    const cmp = a.timestamp.localeCompare(b.timestamp);
    return cmp !== 0 ? cmp : 0;
  });

  return { featureRunId, entries };
}
