import { NextResponse } from "next/server";
import { query, withTransaction } from "@/lib/db";
import { jsonError, num } from "@/lib/api";
import { deriveIsSpending } from "@/lib/taxonomy";
import {
  applyMerchantDefault,
  replaceSplits,
  saveSplitTemplate,
  validateSplits,
  type SplitInput,
} from "@/lib/txnWrite";

export const dynamic = "force-dynamic";

// Per-transaction detail + edit + soft-delete. Feeds the edit/split modal.

type DetailRow = {
  id: number;
  occurred_at: string;
  posted_at: string | null;
  amount: string;
  category: string | null;
  txn_type: string;
  is_spending: boolean;
  notes: string | null;
  source: string;
  account_id: number;
  account_name: string;
  merchant_id: number | null;
  merchant_raw: string;
  display_name: string | null;
  default_category: string | null;
  locked: boolean | null;
};

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

// GET — everything the modal needs to render an existing transaction: the row,
// its current merchant (clean name + whether it's locked), its splits, and the
// merchant's saved split template (offered as one-tap).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = parseId((await params).id);
    if (id === null) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    const { rows } = await query<DetailRow>(
      `SELECT t.id,
              t.occurred_at::text AS occurred_at,
              t.posted_at::text   AS posted_at,
              t.amount,
              t.category,
              t.txn_type,
              t.is_spending,
              t.notes,
              t.source,
              t.account_id,
              a.name AS account_name,
              t.merchant_id,
              t.merchant_raw,
              m.display_name,
              m.default_category,
              m.locked
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN merchants m ON m.id = t.merchant_id
       WHERE t.id = $1 AND t.is_deleted = false`,
      [id],
    );
    const row = rows[0];
    if (!row) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { rows: splitRows } = await query<{
      category: string;
      percent: string;
      notes: string | null;
    }>(
      `SELECT category, percent, notes
       FROM transaction_splits
       WHERE transaction_id = $1
       ORDER BY id`,
      [id],
    );

    let splitTemplate: { category: string; percent: number }[] | null = null;
    if (row.merchant_id) {
      const { rows: tplRows } = await query<{
        lines: { category: string; percent: number }[];
      }>(`SELECT lines FROM split_templates WHERE merchant_id = $1`, [
        row.merchant_id,
      ]);
      if (tplRows[0]) splitTemplate = tplRows[0].lines;
    }

    return NextResponse.json({
      id: row.id,
      occurred_at: row.occurred_at,
      posted_at: row.posted_at,
      amount: num(row.amount),
      category: row.category,
      txn_type: row.txn_type,
      is_spending: row.is_spending,
      notes: row.notes,
      source: row.source,
      account_id: row.account_id,
      account_name: row.account_name,
      merchant_id: row.merchant_id,
      merchant_raw: row.merchant_raw,
      merchant: row.merchant_id
        ? {
            id: row.merchant_id,
            display_name: row.display_name ?? "",
            default_category: row.default_category,
            locked: row.locked ?? false,
          }
        : null,
      splits: splitRows.map((s) => ({
        category: s.category,
        percent: num(s.percent),
        notes: s.notes,
      })),
      split_template: splitTemplate,
    });
  } catch (err) {
    return jsonError(err);
  }
}

type PatchBody = {
  occurred_at?: string;
  amount?: number;
  category?: string | null;
  txn_type?: string;
  account_id?: number;
  notes?: string | null;
  merchant_id?: number | null;
  apply_to_merchant?: boolean;
  splits?: SplitInput[] | null;
  save_split_template?: boolean;
};

// PATCH — edit any field. Imported data is a starting point, not a lock: date,
// amount, category, account, type, notes, and the merchant pointer are all
// editable. Re-categorizing sets user_corrected=true (§10 learning rule); the
// optional apply_to_merchant flag pushes the change to the merchant default.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = parseId((await params).id);
    if (id === null) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }
    const body = (await request.json().catch(() => ({}))) as PatchBody;

    const splits = body.splits ?? null;
    if (splits && splits.length > 0) {
      const err = validateSplits(splits);
      if (err) return NextResponse.json({ error: err }, { status: 400 });
    }

    const result = await withTransaction(async (client) => {
      // Load the current row (locking it) to know what actually changed.
      const { rows: currentRows } = await client.query<{
        category: string | null;
        merchant_id: number | null;
        txn_type: string;
        account_id: number;
        amount: string;
        occurred_at: string;
        notes: string | null;
      }>(
        `SELECT category, merchant_id, txn_type, account_id, amount,
                occurred_at::text AS occurred_at, notes
         FROM transactions
         WHERE id = $1 AND is_deleted = false
         FOR UPDATE`,
        [id],
      );
      const current = currentRows[0];
      if (!current) return { notFound: true as const };

      const nextCategory =
        body.category !== undefined ? body.category : current.category;
      const nextTxnType =
        body.txn_type !== undefined ? body.txn_type : current.txn_type;
      const nextMerchantId =
        body.merchant_id !== undefined
          ? body.merchant_id
          : current.merchant_id;
      const nextAccountId =
        body.account_id !== undefined ? body.account_id : current.account_id;
      const nextOccurredAt =
        body.occurred_at !== undefined
          ? body.occurred_at
          : current.occurred_at;
      const nextAmount =
        body.amount !== undefined ? body.amount : Number(current.amount);
      const nextNotes =
        body.notes !== undefined ? body.notes : current.notes;

      const isSpending = deriveIsSpending(nextCategory, nextTxnType);
      const categoryChanged = nextCategory !== current.category;

      await client.query(
        `UPDATE transactions
         SET occurred_at    = $2,
             amount         = $3,
             category       = $4,
             txn_type       = $5,
             account_id     = $6,
             merchant_id    = $7,
             notes          = $8,
             is_spending    = $9,
             user_corrected = CASE WHEN $10 THEN true ELSE user_corrected END
         WHERE id = $1`,
        [
          id,
          nextOccurredAt,
          nextAmount,
          nextCategory,
          nextTxnType,
          nextAccountId,
          nextMerchantId,
          nextNotes,
          isSpending,
          categoryChanged,
        ],
      );

      // Splits replace wholesale when the key is present (null/[] clears them).
      if (splits !== null) {
        await replaceSplits(client, id, splits);
      }

      // Learning rule + template, only meaningful with a merchant.
      if (nextMerchantId) {
        if (body.apply_to_merchant && nextCategory) {
          await applyMerchantDefault(client, nextMerchantId, id, nextCategory);
        }
        if (body.save_split_template && splits && splits.length > 0) {
          await saveSplitTemplate(client, nextMerchantId, splits);
        }
      }

      return { notFound: false as const };
    });

    if (result.notFound) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return jsonError(err);
  }
}

// DELETE — soft delete only (§11 shared interactions). Never hard-delete; the row
// stays for re-processing/audit and just drops out of every aggregation.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = parseId((await params).id);
    if (id === null) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }
    const { rowCount } = await query(
      `UPDATE transactions SET is_deleted = true WHERE id = $1 AND is_deleted = false`,
      [id],
    );
    if (rowCount === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return jsonError(err);
  }
}
