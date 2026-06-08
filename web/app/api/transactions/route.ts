import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getDateRange, jsonError, num } from "@/lib/api";

export const dynamic = "force-dynamic";

// The period transaction list for the Transactions page. Not in db/queries.sql
// (it's a plain row list, not an aggregation), so built from the schema here.
// Optional filters: category (exact), account (id if numeric, else account name).
// Rows show each transaction's OWN category/type — split lines are an aggregation
// concern handled by queries 1 and 5, not this flat list.

type Row = {
  id: number;
  occurred_at: string;
  merchant: string;
  merchant_raw: string;
  amount: string;
  account: string;
  category: string | null;
  txn_type: string;
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
             t.txn_type
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
      })),
    );
  } catch (err) {
    return jsonError(err);
  }
}
