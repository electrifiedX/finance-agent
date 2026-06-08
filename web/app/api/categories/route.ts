import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getDateRange, jsonError, num } from "@/lib/api";

export const dynamic = "force-dynamic";

// db/queries.sql query 1 — spending by category (splits-aware), highest first.
// A split transaction is counted by its splits and NOT by its own category.
const SQL = `
WITH lines AS (
  SELECT t.id, t.occurred_at, t.amount, t.category, t.is_spending
  FROM transactions t
  WHERE t.is_deleted = false
    AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)
  UNION ALL
  SELECT t.id, t.occurred_at, ROUND(t.amount * s.percent / 100.0, 2), s.category, t.is_spending
  FROM transactions t
  JOIN transaction_splits s ON s.transaction_id = t.id
  WHERE t.is_deleted = false
)
SELECT category, SUM(-amount) AS spend
FROM lines
WHERE is_spending = true
  AND occurred_at BETWEEN $1 AND $2
GROUP BY category
ORDER BY spend DESC
`;

type Row = { category: string; spend: string };

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { start, end } = getDateRange(searchParams);
    const { rows } = await query<Row>(SQL, [start, end]);
    return NextResponse.json(
      rows.map((r) => ({ category: r.category, spend: num(r.spend) })),
    );
  } catch (err) {
    return jsonError(err);
  }
}
