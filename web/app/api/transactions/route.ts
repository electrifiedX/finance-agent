import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { query, withTransaction } from "@/lib/db";
import { getDateRange, jsonError, num } from "@/lib/api";
import { deriveIsSpending, fingerprint } from "@/lib/taxonomy";
import {
  applyMerchantDefault,
  replaceSplits,
  saveSplitTemplate,
  validateSplits,
  type SplitInput,
} from "@/lib/txnWrite";

export const dynamic = "force-dynamic";

// The period transaction list for the Transactions page. Not in db/queries.sql
// (it's a plain row list, not an aggregation), so built from the schema here.
// Optional filters: category (exact), account (id if numeric, else account name).
// Rows show each transaction's OWN category/type — split lines are an aggregation
// concern handled by queries 1 and 5, not this flat list.

type SplitJson = { category: string; percent: number };
type Row = {
  id: number;
  occurred_at: string;
  merchant: string;
  merchant_raw: string;
  amount: string;
  account: string;
  category: string | null;
  txn_type: string;
  is_spending: boolean;
  splits: SplitJson[];
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { start, end } = getDateRange(searchParams);
    const category = searchParams.get("category");
    const account = searchParams.get("account");

    const params: unknown[] = [start, end];
    const where: string[] = [
      "t.is_deleted = false",
      "t.occurred_at BETWEEN $1 AND $2",
    ];

    if (category) {
      params.push(category);
      where.push(`t.category = $${params.length}`);
    }

    if (account) {
      // Accept either a numeric account id or an account name.
      if (/^\d+$/.test(account)) {
        params.push(Number.parseInt(account, 10));
        where.push(`a.id = $${params.length}`);
      } else {
        params.push(account);
        where.push(`a.name = $${params.length}`);
      }
    }

    const sql = `
      SELECT t.id,
             t.occurred_at::text AS occurred_at,
             COALESCE(m.display_name, t.merchant_raw) AS merchant,
             t.merchant_raw,
             t.amount,
             a.name AS account,
             t.category,
             t.txn_type,
             t.is_spending,
             COALESCE((
               SELECT json_agg(
                        json_build_object('category', s.category, 'percent', s.percent)
                        ORDER BY s.id)
               FROM transaction_splits s
               WHERE s.transaction_id = t.id
             ), '[]'::json) AS splits
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN merchants m ON m.id = t.merchant_id
      WHERE ${where.join("\n        AND ")}
      ORDER BY t.occurred_at DESC, t.id DESC
    `;

    const { rows } = await query<Row>(sql, params);
    return NextResponse.json(
      rows.map((r) => ({
        id: r.id,
        occurred_at: r.occurred_at,
        merchant: r.merchant,
        merchant_raw: r.merchant_raw,
        amount: num(r.amount),
        account: r.account,
        category: r.category,
        txn_type: r.txn_type,
        is_spending: r.is_spending,
        splits: (r.splits ?? []).map((s) => ({
          category: s.category,
          // pg returns NUMERIC inside json as a number already, but coerce to be safe.
          percent: Number(s.percent),
        })),
      })),
    );
  } catch (err) {
    return jsonError(err);
  }
}

type PostBody = {
  occurred_at?: string;
  amount?: number;
  account_id?: number;
  category?: string | null;
  txn_type?: string;
  notes?: string | null;
  merchant_id?: number | null;
  // When no existing merchant is picked, the typed name creates one on the fly.
  merchant_name?: string;
  apply_to_merchant?: boolean;
  splits?: SplitInput[] | null;
  save_split_template?: boolean;
};

// POST — manual single-transaction entry (also the modal's "+ Add expense" form).
// source='manual', dedupe_key from a UUID so it never collides with an import.
// For manual rows the typed clean name doubles as merchant_raw (there's no bank
// string), and a brand-new vendor name is upserted into merchants first.
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as PostBody;

    const occurredAt = (body.occurred_at || "").trim();
    if (!occurredAt) {
      return NextResponse.json(
        { error: "occurred_at is required" },
        { status: 400 },
      );
    }
    if (typeof body.amount !== "number" || Number.isNaN(body.amount)) {
      return NextResponse.json(
        { error: "amount is required" },
        { status: 400 },
      );
    }
    if (typeof body.account_id !== "number") {
      return NextResponse.json(
        { error: "account_id is required" },
        { status: 400 },
      );
    }

    const merchantName = (body.merchant_name || "").trim();
    if (body.merchant_id == null && !merchantName) {
      return NextResponse.json(
        { error: "A merchant is required" },
        { status: 400 },
      );
    }

    const splits = body.splits ?? null;
    if (splits && splits.length > 0) {
      const err = validateSplits(splits);
      if (err) return NextResponse.json({ error: err }, { status: 400 });
    }

    const category = body.category ?? null;
    const txnType = body.txn_type || "sale";
    const isSpending = deriveIsSpending(category, txnType);

    const newId = await withTransaction(async (client) => {
      // Resolve the merchant: an explicit pick wins, otherwise upsert the typed
      // name by fingerprint so duplicates collapse.
      let merchantId = body.merchant_id ?? null;
      let merchantRaw = merchantName;
      if (!merchantId && merchantName) {
        const fp = fingerprint(merchantName);
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO merchants (raw_fingerprint, display_name)
           VALUES ($1, $2)
           ON CONFLICT (raw_fingerprint)
             DO UPDATE SET updated_at = now()
           RETURNING id`,
          [fp, merchantName],
        );
        merchantId = rows[0].id;
      }
      if (merchantId && !merchantRaw) {
        const { rows } = await client.query<{ display_name: string }>(
          `SELECT display_name FROM merchants WHERE id = $1`,
          [merchantId],
        );
        merchantRaw = rows[0]?.display_name ?? "Manual entry";
      }

      const { rows: inserted } = await client.query<{ id: number }>(
        `INSERT INTO transactions
           (account_id, occurred_at, amount, merchant_id, merchant_raw, category,
            txn_type, is_spending, source, dedupe_key, user_corrected, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', $9, true, $10)
         RETURNING id`,
        [
          body.account_id,
          occurredAt,
          body.amount,
          merchantId,
          merchantRaw || "Manual entry",
          category,
          txnType,
          isSpending,
          `manual:${randomUUID()}`,
          body.notes ?? null,
        ],
      );
      const id = inserted[0].id;

      if (splits && splits.length > 0) {
        await replaceSplits(client, id, splits);
      }
      if (merchantId) {
        if (body.apply_to_merchant && category) {
          await applyMerchantDefault(client, merchantId, id, category);
        }
        if (body.save_split_template && splits && splits.length > 0) {
          await saveSplitTemplate(client, merchantId, splits);
        }
      }
      return id;
    });

    return NextResponse.json({ ok: true, id: newId }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
