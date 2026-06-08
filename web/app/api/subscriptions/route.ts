import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { jsonError, num } from "@/lib/api";

export const dynamic = "force-dynamic";

// db/queries.sql query 7 — recurring/subscription detection. Merchants charged in
// >= 3 distinct months with a roughly stable amount. All-time, ignores dates.
const SQL = `
SELECT m.display_name AS vendor,
       ROUND(AVG(-t.amount), 2)                            AS avg_monthly,
       ROUND(AVG(-t.amount) * 12, 2)                       AS annualized,
       COUNT(DISTINCT date_trunc('month', t.occurred_at))  AS months_seen
FROM transactions t
JOIN merchants m ON m.id = t.merchant_id
WHERE t.is_deleted = false
  AND t.is_spending = true
GROUP BY m.display_name
HAVING COUNT(DISTINCT date_trunc('month', t.occurred_at)) >= 3
   AND stddev_pop(-t.amount) < (AVG(-t.amount) * 0.25)
ORDER BY annualized DESC
`;

type Row = {
  vendor: string;
  avg_monthly: string;
  annualized: string;
  months_seen: string;
};

export async function GET() {
  try {
    const { rows } = await query<Row>(SQL);
    return NextResponse.json(
      rows.map((r) => ({
        vendor: r.vendor,
        avg_monthly: num(r.avg_monthly),
        annualized: num(r.annualized),
        months_seen: num(r.months_seen),
      })),
    );
  } catch (err) {
    return jsonError(err);
  }
}
