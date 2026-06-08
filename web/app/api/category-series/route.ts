import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getDateRange, jsonError, num } from "@/lib/api";

export const dynamic = "force-dynamic";

// db/queries.sql query 5 — single-category monthly series (splits-aware).
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
SELECT date_trunc('month', occurred_at)::date::text AS month, SUM(-amount) AS spend
FROM lines
WHERE is_spending = true
  AND category = $1
  AND occurred_at BETWEEN $2 AND $3
GROUP BY 1
ORDER BY 1
`;

type Row = { month: string; spend: string };

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category");
    if (!category) {
      return NextResponse.json(
        { error: "category query param is required" },
        { status: 400 },
      );
    }
    const { start, end } = getDateRange(searchParams);
    const { rows } = await query<Row>(SQL, [category, start, end]);
    return NextResponse.json(
      rows.map((r) => ({ month: r.month, spend: num(r.spend) })),
    );
  } catch (err) {
    return jsonError(err);
  }
}
