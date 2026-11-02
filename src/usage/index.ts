import type { Db } from '../db/index';
import type { Usage } from '../extraction/extract';

/** Dollars per million tokens. */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

export class BudgetExceeded extends Error {
  constructor() {
    super('This business has reached its monthly AI spending limit');
    this.name = 'BudgetExceeded';
  }
}

export function costUsd(model: string, usage: Usage) {
  const price = MODEL_PRICES[model];
  // An unpriced model must fail loudly, or the spending limit would silently stop working.
  if (!price) throw new Error(`No price known for ${model}`);
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

export async function monthlySpendUsd(db: Db, tenantId: string) {
  const { rows } = await db.query<{ total: string | null }>(
    `SELECT sum(cost_usd) AS total FROM extraction_usage
     WHERE tenant_id = $1 AND created_at >= date_trunc('month', now())`,
    [tenantId],
  );
  return Number(rows[0]?.total ?? 0);
}

export async function assertWithinBudget(db: Db, tenantId: string, limitUsd: number) {
  if ((await monthlySpendUsd(db, tenantId)) >= limitUsd) throw new BudgetExceeded();
}

export async function recordUsage(
  db: Db,
  input: { tenantId: string; caseId: string; model: string; usage: Usage },
) {
  await db.query(
    `INSERT INTO extraction_usage (tenant_id, case_id, model, input_tokens, output_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.tenantId,
      input.caseId,
      input.model,
      input.usage.inputTokens,
      input.usage.outputTokens,
      costUsd(input.model, input.usage),
    ],
  );
}

export async function uploadsInLastHour(db: Db, tenantId: string) {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*) FROM quote_cases WHERE tenant_id = $1 AND created_at > now() - interval '1 hour'`,
    [tenantId],
  );
  return Number(rows[0]!.count);
}
