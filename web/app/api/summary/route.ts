import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getDateRange, jsonError, num } from "@/lib/api";

export const dynamic = "force-dynamic";

// db/queries.sql query 3 — period summary: income, expenses, net.
const SQL = `
SELECT
  COALESCE(SUM(amount) FILTER (WHERE category IN ('income','misc_income')), 0) AS income,
  COALESCE(SUM(-amount) FILTER (WHERE is_spending = true), 0)                 AS expenses,
  COALESCE(SUM(amount) FILTER (WHERE category IN ('income','misc_income')), 0)
    - COALESCE(SUM(-amount) FILTER (WHERE is_spending = true), 0)             AS net
FROM transactions
WHERE is_deleted = false
  AND occurred_at BETWEEN $1 AND $2
`;

type Row = { income: string; expenses: string; net: string };

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { start, end } = getDateRange(searchParams);
    const { rows } = await query<Row>(SQL, [start, end]);
    const row = rows[0];
    return NextResponse.json({
      income: num(row?.income),
      expenses: num(row?.expenses),
      net: num(row?.net),
    });
  } catch (err) {
    return jsonError(err);
  }
}
