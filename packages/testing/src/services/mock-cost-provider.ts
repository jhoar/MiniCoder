import type { DbClient } from '@minicoder/core';

export interface CostRecord {
  agentRunId: string;
  tokens: number;
  model: string;
  estimatedCost: number;
  recordedAt: string;
}

const DEFAULT_COST_PER_TOKEN = 0.000002;

export class MockCostProvider {
  readonly records: CostRecord[] = [];
  readonly costPerToken: number;

  constructor(costPerToken = DEFAULT_COST_PER_TOKEN) {
    this.costPerToken = costPerToken;
  }

  async recordCost(
    db: DbClient,
    params: {
      id: string;
      projectId: string;
      featureRequestId?: string;
      featureRunId?: string;
      tokens: number;
      model: string;
      scope?: string;
    },
  ): Promise<void> {
    const amount = params.tokens * this.costPerToken;
    const recordedAt = new Date().toISOString();
    const scope = params.scope ?? 'feature';

    await db.execute(
      `INSERT INTO cost_records
         (id, project_id, feature_request_id, feature_run_id, scope, amount, currency,
          model, input_tokens, output_tokens, recorded_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
      [
        params.id,
        params.projectId,
        params.featureRequestId ?? null,
        params.featureRunId ?? null,
        scope,
        amount,
        params.model,
        Math.floor(params.tokens * 0.3),
        Math.floor(params.tokens * 0.7),
        recordedAt,
      ],
    );

    this.records.push({
      agentRunId: params.id,
      tokens: params.tokens,
      model: params.model,
      estimatedCost: amount,
      recordedAt,
    });
  }

  totalCost(): number {
    return this.records.reduce((sum, r) => sum + r.estimatedCost, 0);
  }

  reset(): void {
    this.records.length = 0;
  }
}
