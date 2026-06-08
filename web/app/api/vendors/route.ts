import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getDateRange, jsonError, num } from "@/lib/api";

export const dynamic = "force-dynamic";

// db/queries.sql query 2 — top vendors for a period by spend, with txn count.
const SQL = `
SELECT m.display_name AS vendor, SUM(-t.amount) AS spend, COUNT(*) AS txns
FROM transactions t
JOIN merchants m ON m.id = t.merchant_id
WHERE t.is_deleted = false
  AND t.is_spending = true
  AND t.occurred_at BETWEEN $1 AND $2
GROUP BY m.display_name
ORDER BY spend DESC
LIMIT 25
`;

type Row = { vendor: string; spend: string; txns: string };

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { start, end } = getDateRange(searchParams);
    const { rows } = await query<Row>(SQL, [start, end]);
    return NextResponse.json(
      rows.map((r) => ({
        vendor: r.vendor,
        spend: num(r.spend),
        txns: num(r.txns),
      })),
    );
  } catch (err) {
    return jsonError(err);
  }
}
