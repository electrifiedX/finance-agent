import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

type CountRow = { count: string };

export default async function Home() {
  let transactionCount: number | null = null;
  let error: string | null = null;

  try {
    const result = await query<CountRow>(
      "SELECT COUNT(*)::text AS count FROM transactions WHERE NOT is_deleted",
    );
    transactionCount = Number.parseInt(result.rows[0]?.count ?? "0", 10);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to connect to Postgres";
  }

  return (
    <main className="flex min-h-full flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-8 shadow-lg">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">
          Family Finance Tracker
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Dashboard scaffold — Postgres connectivity check
        </p>

        {error ? (
          <div className="mt-6 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-red-300">
            <p className="font-medium">Database connection failed</p>
            <p className="mt-1 text-sm text-red-400/90">{error}</p>
          </div>
        ) : (
          <div className="mt-6 rounded-lg border border-emerald-900/50 bg-emerald-950/30 px-4 py-3">
            <p className="text-sm text-emerald-400/90">Connected to Postgres</p>
            <p className="mt-2 font-mono text-3xl tabular-nums text-emerald-300">
              {transactionCount?.toLocaleString() ?? "—"}
            </p>
            <p className="mt-1 text-sm text-zinc-400">
              transactions in database (excluding soft-deleted)
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
