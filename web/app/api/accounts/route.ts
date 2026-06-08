import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";

// Accounts list for the Transactions account filter (and display).
// last4 lives in the separate account_last4s table (one account can have many
// cards, and card numbers are ephemeral) — the web app never surfaces it.
type Row = {
  id: number;
  name: string;
  institution: string | null;
  type: string;
};

export async function GET() {
  try {
    const { rows } = await query<Row>(
      `SELECT id, name, institution, type
       FROM accounts
       ORDER BY type, name`,
    );
    return NextResponse.json(rows);
  } catch (err) {
    return jsonError(err);
  }
}
