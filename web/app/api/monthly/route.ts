import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getDateRange, jsonError, num } from "@/lib/api";

export const dynamic = "force-dynamic";

// db/queries.sql query 4 — per-month income/expenses/net. ::text on the month
// keeps it a clean YYYY-MM-DD string (avoids pg Date timezone drift in JSON).
const SQL = `
SELECT
  date_trunc('month', occurred_at)::date::text AS month,
  COALESCE(SUM(amount) FILTER (WHERE category IN ('income','misc_income')), 0) AS income,
  COALESCE(SUM(-amount) FILTER (WHERE is_spending = true), 0)                 AS expenses,
  COALESCE(SUM(amount) FILTER (WHERE category IN ('income','misc_income')), 0)
    - COALESCE(SUM(-amount) FILTER (WHERE is_spending = true), 0)             AS net
FROM transactions
WHERE is_deleted = false
  AND occurred_at BETWEEN $1 AND $2
GROUP BY 1
ORDER BY 1
`;

type Row = { month: string; income: string; expenses: string; net: string };

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { start, end } = getDateRange(searchParams);
    const { rows } = await query<Row>(SQL, [start, end]);
    return NextResponse.json(
      rows.map((r) => ({
        month: r.month,
        income: num(r.income),
        expenses: num(r.expenses),
        net: num(r.net),
      })),
    );
  } catch (err) {
    return jsonError(err);
  }
}
