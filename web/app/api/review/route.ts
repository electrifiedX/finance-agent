import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { jsonError, num } from "@/lib/api";

export const dynamic = "force-dynamic";

// db/queries.sql query 6 — "to review" backlog. ALWAYS all-time; ignores dates.
const SQL = `
SELECT t.id, t.occurred_at::text AS occurred_at, m.display_name, t.merchant_raw,
       t.amount, t.category, t.confidence
FROM transactions t
JOIN merchants m ON m.id = t.merchant_id
WHERE t.is_deleted = false
  AND t.user_corrected = false
  AND (t.category = 'uncategorized' OR t.category = 'needs_review' OR t.confidence < 0.7)
ORDER BY t.occurred_at DESC
`;

type Row = {
  id: number;
  occurred_at: string;
  display_name: string;
  merchant_raw: string;
  amount: string;
  category: string | null;
  confidence: string | null;
};

export async function GET() {
  try {
    const { rows } = await query<Row>(SQL);
    return NextResponse.json(
      rows.map((r) => ({
        id: r.id,
        occurred_at: r.occurred_at,
        display_name: r.display_name,
        merchant_raw: r.merchant_raw,
        amount: num(r.amount),
        category: r.category,
        confidence: r.confidence === null ? null : num(r.confidence),
      })),
    );
  } catch (err) {
    return jsonError(err);
  }
}
