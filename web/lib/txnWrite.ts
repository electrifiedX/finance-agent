import type { PoolClient } from "pg";

// Shared write helpers for the edit (PATCH) and manual-add (POST) routes, so both
// paths treat splits, the per-merchant learning rule, and split templates
// identically. All run inside a withTransaction() client.

export type SplitInput = {
  category: string;
  percent: number;
  notes?: string | null;
};

// Percentages are the source of truth (§10): they survive amount corrections and
// always reconcile to the parent. Enforce SUM == 100 here as a server-side guard
// even though the UI also blocks save — the DB has no such constraint.
export function validateSplits(splits: SplitInput[]): string | null {
  if (splits.length === 0) return null;
  if (splits.length === 1) {
    return "A split needs at least two category lines.";
  }
  for (const s of splits) {
    if (!s.category) return "Every split line needs a category.";
    if (!(s.percent > 0 && s.percent <= 100)) {
      return "Split percentages must be between 0 and 100.";
    }
  }
  // Sum to a hundredth of a percent to absorb float noise from the UI.
  const total = splits.reduce((sum, s) => sum + s.percent, 0);
  if (Math.abs(total - 100) > 0.01) {
    return `Split percentages must sum to 100 (currently ${total.toFixed(2)}).`;
  }
  return null;
}

// Replace a transaction's split set wholesale. Empty array clears all splits
// (the txn falls back to its own category — the common, unsplit case).
export async function replaceSplits(
  client: PoolClient,
  transactionId: number,
  splits: SplitInput[],
): Promise<void> {
  await client.query(
    `DELETE FROM transaction_splits WHERE transaction_id = $1`,
    [transactionId],
  );
  for (const s of splits) {
    await client.query(
      `INSERT INTO transaction_splits (transaction_id, category, percent, notes)
       VALUES ($1, $2, $3, $4)`,
      [transactionId, s.category, s.percent, s.notes ?? null],
    );
  }
}

// The learning rule (§10): "apply to this merchant going forward" sets the
// merchant default + locks it (LLM won't overwrite) and logs the correction so we
// can later see which merchants keep getting re-corrected.
export async function applyMerchantDefault(
  client: PoolClient,
  merchantId: number,
  transactionId: number,
  newCategory: string,
): Promise<void> {
  const { rows } = await client.query<{ default_category: string | null }>(
    `SELECT default_category FROM merchants WHERE id = $1`,
    [merchantId],
  );
  const oldCategory = rows[0]?.default_category ?? null;

  await client.query(
    `UPDATE merchants
     SET default_category = $2, locked = true, updated_at = now()
     WHERE id = $1`,
    [merchantId, newCategory],
  );

  await client.query(
    `INSERT INTO category_corrections
       (merchant_id, transaction_id, old_category, new_category)
     VALUES ($1, $2, $3, $4)`,
    [merchantId, transactionId, oldCategory, newCategory],
  );
}

// Save the current split layout as the merchant's one-tap template (§10). One
// template per merchant (UNIQUE) — newest layout wins.
export async function saveSplitTemplate(
  client: PoolClient,
  merchantId: number,
  splits: SplitInput[],
): Promise<void> {
  const lines = splits.map((s) => ({
    category: s.category,
    percent: s.percent,
  }));
  await client.query(
    `INSERT INTO split_templates (merchant_id, lines)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (merchant_id)
       DO UPDATE SET lines = EXCLUDED.lines, created_at = now()`,
    [merchantId, JSON.stringify(lines)],
  );
}
