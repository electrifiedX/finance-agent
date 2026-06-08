import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { jsonError } from "@/lib/api";
import { fingerprint } from "@/lib/taxonomy";

export const dynamic = "force-dynamic";

// Merchant search + create. Powers the edit/add modal's searchable vendor field.
//
// GET /api/merchants?q=chip
//   Fuzzy-search EXISTING merchants by display name (and raw fingerprint, so a
//   bank string still finds its merchant). Picking a result re-points a txn to an
//   existing merchant_id — the whole point is to avoid near-duplicate vendors
//   like "Dicks" vs "Dick's".
//
// POST /api/merchants { display_name }
//   Explicit "create new vendor" path only. Fingerprints the name and upserts so
//   two hand-created "Chipotle"s still collapse to one row.

type MerchantRow = {
  id: number;
  display_name: string;
  default_category: string | null;
  locked: boolean;
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = (searchParams.get("q") || "").trim();

    // Empty query returns the most-used merchants so the dropdown is never blank.
    if (!q) {
      const { rows } = await query<MerchantRow>(
        `SELECT m.id, m.display_name, m.default_category, m.locked
         FROM merchants m
         LEFT JOIN transactions t ON t.merchant_id = m.id AND t.is_deleted = false
         GROUP BY m.id
         ORDER BY COUNT(t.id) DESC, m.display_name
         LIMIT 20`,
      );
      return NextResponse.json(rows);
    }

    const like = `%${q}%`;
    const prefix = `${q}%`;
    const { rows } = await query<MerchantRow>(
      `SELECT id, display_name, default_category, locked
       FROM merchants
       WHERE display_name ILIKE $1 OR raw_fingerprint ILIKE $1
       ORDER BY (display_name ILIKE $2) DESC, length(display_name), display_name
       LIMIT 20`,
      [like, prefix],
    );
    return NextResponse.json(rows);
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const displayName = String(body?.display_name ?? "").trim();
    if (!displayName) {
      return NextResponse.json(
        { error: "display_name is required" },
        { status: 400 },
      );
    }

    const fp = fingerprint(displayName);
    // Upsert on fingerprint: a genuinely new vendor inserts; a collision returns
    // the existing merchant instead of creating a duplicate.
    const { rows } = await query<MerchantRow>(
      `INSERT INTO merchants (raw_fingerprint, display_name)
       VALUES ($1, $2)
       ON CONFLICT (raw_fingerprint)
         DO UPDATE SET updated_at = now()
       RETURNING id, display_name, default_category, locked`,
      [fp, displayName],
    );
    return NextResponse.json(rows[0], { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
