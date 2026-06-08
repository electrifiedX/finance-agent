"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import SiteHeader from "@/app/components/SiteHeader";
import DateRangeSelector from "@/app/components/DateRangeSelector";
import CategoryPie from "@/app/components/CategoryPie";
import {
  absMoney0,
  categoryLabel,
  dayShort,
  money0,
  money2,
  monthBounds,
  toIso,
} from "@/lib/format";
import { ALL_CATEGORIES } from "@/lib/taxonomy";

type Summary = { income: number; expenses: number; net: number };
type CategoryRow = { category: string; spend: number };
type VendorRow = { vendor: string; spend: number; txns: number };
type TxnRow = {
  id: number;
  occurred_at: string;
  merchant: string;
  merchant_raw: string;
  amount: number;
  account: string;
  category: string | null;
  txn_type: string;
};
type ReviewRow = {
  id: number;
  occurred_at: string;
  display_name: string;
  merchant_raw: string;
  amount: number;
  category: string | null;
  confidence: number | null;
};
type Account = {
  id: number;
  name: string;
  institution: string | null;
  type: string;
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed: ${url}`);
  }
  return res.json() as Promise<T>;
}

// Why an item is in the review backlog — drives the small label on each row.
function reviewReason(row: ReviewRow): string {
  if (row.category === "needs_review") return "Needs review";
  if (row.category === "uncategorized") return "Uncategorized";
  if (row.confidence !== null) {
    return `Low confidence ${Math.round(row.confidence * 100)}%`;
  }
  return "Review";
}

export default function TransactionsPage() {
  return (
    <div className="min-h-full bg-background">
      <SiteHeader active="transactions" />
      <Suspense fallback={<PageFallback />}>
        <TransactionsView />
      </Suspense>
    </div>
  );
}

function TransactionsView() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const defaults = useMemo(() => monthBounds(toIso(new Date())), []);
  const start = searchParams.get("start") || defaults.start;
  const end = searchParams.get("end") || defaults.end;
  const category = searchParams.get("category") || "";
  const account = searchParams.get("account") || "";

  function setParams(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("start", start);
    params.set("end", end);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    router.replace(`/transactions?${params.toString()}`, { scroll: false });
  }

  // Section A — review backlog. All-time, fetched once, independent of filters.
  const [review, setReview] = useState<ReviewRow[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);

  useEffect(() => {
    fetchJson<ReviewRow[]>("/api/review")
      .then(setReview)
      .catch(() => setReview([]));
    fetchJson<Account[]>("/api/accounts")
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  // Sections C–E — scoped to the selected range + filters.
  const [summary, setSummary] = useState<Summary | null>(null);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [txns, setTxns] = useState<TxnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;

    const qs = new URLSearchParams({ start, end });
    if (category) qs.set("category", category);
    if (account) qs.set("account", account);
    const periodQs = new URLSearchParams({ start, end }).toString();

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [s, c, v, t] = await Promise.all([
          fetchJson<Summary>(`/api/summary?${periodQs}`),
          fetchJson<CategoryRow[]>(`/api/categories?${periodQs}`),
          fetchJson<VendorRow[]>(`/api/vendors?${periodQs}`),
          fetchJson<TxnRow[]>(`/api/transactions?${qs.toString()}`),
        ]);
        if (cancelled) return;
        setSummary(s);
        setCategories(c);
        setVendors(v);
        setTxns(t);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load data");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [start, end, category, account]);

  const filteredTxns = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return txns;
    return txns.filter(
      (t) =>
        t.merchant.toLowerCase().includes(q) ||
        t.merchant_raw.toLowerCase().includes(q),
    );
  }, [txns, search]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-medium tracking-tight text-ink">
          Transactions
        </h1>
        <p className="mt-1 text-sm text-muted">
          Clear the review backlog, then dig into a period.
        </p>
      </div>

      <ToReviewSection review={review} />

      <FilterBar
        start={start}
        end={end}
        category={category}
        account={account}
        accounts={accounts}
        search={search}
        onRange={(s, e) => setParams({ start: s, end: e })}
        onCategory={(c) => setParams({ category: c })}
        onAccount={(a) => setParams({ account: a })}
        onSearch={setSearch}
      />

      {error ? (
        <div className="mt-6 rounded-2xl border border-neg/40 bg-neg-soft/40 px-5 py-4 text-sm text-neg">
          <p className="font-medium">Couldn’t load this period</p>
          <p className="mt-1 opacity-90">{error}</p>
        </div>
      ) : loading ? (
        <PeriodFallback />
      ) : (
        <>
          <PeriodSummary summary={summary} categories={categories} />
          <TopLists
            categories={categories}
            vendors={vendors}
            totalSpend={summary?.expenses ?? 0}
          />
          <TransactionList rows={filteredTxns} total={txns.length} />
        </>
      )}
    </main>
  );
}

function ToReviewSection({ review }: { review: ReviewRow[] | null }) {
  if (review === null) {
    return (
      <section className="mb-6 h-24 animate-pulse rounded-2xl border border-line bg-surface" />
    );
  }

  if (review.length === 0) {
    return (
      <section className="mb-6 flex items-center gap-3 rounded-2xl border border-pos/30 bg-pos-soft/30 px-5 py-4">
        <span
          className="grid h-8 w-8 place-items-center rounded-full bg-pos/15 text-pos"
          aria-hidden
        >
          ✓
        </span>
        <div>
          <p className="font-medium text-ink">All caught up</p>
          <p className="text-sm text-muted">
            Nothing needs review — you’re all up to date.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-accent/30 bg-surface">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-ink">To review</h2>
          <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent">
            {review.length}
          </span>
        </div>
        <span className="text-xs text-muted">All time · ignores the filter below</span>
      </div>
      <ul className="divide-y divide-line">
        {review.map((row) => (
          <li
            key={row.id}
            className="flex cursor-pointer items-center gap-4 px-5 py-3 transition-colors hover:bg-surface-2"
            title="Resolve in the editor (coming next)"
          >
            <span className="w-14 shrink-0 text-xs text-muted">
              {dayShort(row.occurred_at)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-ink">
                {row.display_name || row.merchant_raw}
              </span>
              <span className="block truncate text-xs text-muted">
                {row.merchant_raw}
              </span>
            </span>
            <span className="rounded-md bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
              {reviewReason(row)}
            </span>
            <span
              className="money w-24 shrink-0 text-right text-sm"
              style={{
                color: row.amount >= 0 ? "var(--color-pos)" : "var(--color-ink)",
              }}
            >
              {money2(row.amount)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FilterBar({
  start,
  end,
  category,
  account,
  accounts,
  search,
  onRange,
  onCategory,
  onAccount,
  onSearch,
}: {
  start: string;
  end: string;
  category: string;
  account: string;
  accounts: Account[];
  search: string;
  onRange: (start: string, end: string) => void;
  onCategory: (category: string) => void;
  onAccount: (account: string) => void;
  onSearch: (q: string) => void;
}) {
  const selectCls =
    "rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm font-medium text-ink outline-none transition-colors hover:border-line-strong focus:border-accent";

  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <DateRangeSelector start={start} end={end} onChange={onRange} />

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <select
          value={category}
          onChange={(e) => onCategory(e.target.value)}
          className={selectCls}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {ALL_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </select>

        <select
          value={account}
          onChange={(e) => onAccount(e.target.value)}
          className={selectCls}
          aria-label="Filter by account"
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={String(a.id)}>
              {a.name}
            </option>
          ))}
        </select>

        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search merchant…"
          className="ml-auto w-full max-w-56 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-ink outline-none transition-colors placeholder:text-muted hover:border-line-strong focus:border-accent"
        />
      </div>
    </section>
  );
}

function PeriodSummary({
  summary,
  categories,
}: {
  summary: Summary | null;
  categories: CategoryRow[];
}) {
  if (!summary) return null;
  const positive = summary.net >= 0;

  return (
    <section className="mt-6 grid grid-cols-1 gap-6 rounded-2xl border border-line bg-surface p-5 sm:p-6 lg:grid-cols-2">
      <div className="flex flex-col justify-center gap-5">
        <div className="grid grid-cols-2 gap-4">
          <Figure label="Income">
            <span className="money text-2xl font-medium text-ink">
              {money0(summary.income)}
            </span>
          </Figure>
          <Figure label="Expenses">
            <span className="money text-2xl font-medium text-ink">
              {money0(summary.expenses)}
            </span>
          </Figure>
        </div>
        <div className="rounded-xl border border-line bg-surface-2 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">
            Net
          </p>
          <p
            className="money mt-1 text-3xl font-semibold"
            style={{
              color: positive ? "var(--color-pos)" : "var(--color-neg)",
            }}
          >
            {positive ? "+" : "−"}
            {absMoney0(summary.net)}
          </p>
          <p
            className="mt-0.5 text-sm font-medium"
            style={{
              color: positive ? "var(--color-pos)" : "var(--color-neg)",
            }}
          >
            {positive ? "Saved" : "Overspent"} {absMoney0(summary.net)} this
            period
          </p>
        </div>
      </div>

      <div className="flex items-center">
        <div className="w-full">
          <h2 className="mb-3 text-base font-semibold text-ink">
            Spending by category
          </h2>
          <CategoryPie categories={categories} />
        </div>
      </div>
    </section>
  );
}

function Figure({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">
        {label}
      </p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function TopLists({
  categories,
  vendors,
  totalSpend,
}: {
  categories: CategoryRow[];
  vendors: VendorRow[];
  totalSpend: number;
}) {
  const topCategories = categories.filter((c) => c.spend > 0).slice(0, 10);
  const topVendors = vendors.slice(0, 10);

  return (
    <section className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        <h2 className="border-b border-line px-5 py-3 text-base font-semibold text-ink">
          Top categories
        </h2>
        {topCategories.length === 0 ? (
          <EmptyList />
        ) : (
          <ul className="divide-y divide-line">
            {topCategories.map((c) => {
              const pct =
                totalSpend > 0 ? Math.round((c.spend / totalSpend) * 100) : 0;
              return (
                <li
                  key={c.category}
                  className="flex items-center gap-3 px-5 py-2.5"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-soft">
                    {categoryLabel(c.category)}
                  </span>
                  <span className="w-10 text-right text-xs text-muted">
                    {pct}%
                  </span>
                  <span className="money w-24 text-right text-sm text-ink">
                    {money0(c.spend)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        <h2 className="border-b border-line px-5 py-3 text-base font-semibold text-ink">
          Top vendors
        </h2>
        {topVendors.length === 0 ? (
          <EmptyList />
        ) : (
          <ul className="divide-y divide-line">
            {topVendors.map((v) => (
              <li
                key={v.vendor}
                className="flex items-center gap-3 px-5 py-2.5"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-ink-soft">
                  {v.vendor}
                </span>
                <span className="w-14 text-right text-xs text-muted">
                  {v.txns} txn{v.txns === 1 ? "" : "s"}
                </span>
                <span className="money w-24 text-right text-sm text-ink">
                  {money0(v.spend)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function TransactionList({
  rows,
  total,
}: {
  rows: TxnRow[];
  total: number;
}) {
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="text-base font-semibold text-ink">Transactions</h2>
        <span className="text-xs text-muted">
          {rows.length === total
            ? `${total} in period`
            : `${rows.length} of ${total}`}
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyList label="No transactions for this period and filters." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-muted">
                <th className="px-5 py-2 font-semibold">Date</th>
                <th className="px-3 py-2 font-semibold">Merchant</th>
                <th className="px-3 py-2 font-semibold">Account</th>
                <th className="px-3 py-2 font-semibold">Category</th>
                <th className="px-3 py-2 font-semibold">Type</th>
                <th className="px-5 py-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr
                  key={t.id}
                  title={`${t.merchant_raw} — open editor (coming next)`}
                  className="cursor-pointer border-b border-line/60 transition-colors last:border-0 hover:bg-surface-2"
                >
                  <td className="whitespace-nowrap px-5 py-2.5 text-muted">
                    {dayShort(t.occurred_at)}
                  </td>
                  <td className="max-w-[16rem] px-3 py-2.5">
                    <span className="block truncate font-medium text-ink">
                      {t.merchant}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-ink-soft">
                    {t.account}
                  </td>
                  <td className="px-3 py-2.5">
                    {t.category ? (
                      <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-soft">
                        {categoryLabel(t.category)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted">
                    {t.txn_type}
                  </td>
                  <td
                    className="money whitespace-nowrap px-5 py-2.5 text-right"
                    style={{
                      color:
                        t.amount >= 0
                          ? "var(--color-pos)"
                          : "var(--color-ink)",
                    }}
                  >
                    {money2(t.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EmptyList({ label }: { label?: string }) {
  return (
    <div className="px-5 py-10 text-center text-sm text-muted">
      {label ?? "Nothing here for this period."}
    </div>
  );
}

function PageFallback() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="h-24 animate-pulse rounded-2xl border border-line bg-surface" />
      <PeriodFallback />
    </main>
  );
}

function PeriodFallback() {
  return (
    <div className="mt-6 animate-pulse space-y-6">
      <div className="h-44 rounded-2xl border border-line bg-surface" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="h-72 rounded-2xl border border-line bg-surface" />
        <div className="h-72 rounded-2xl border border-line bg-surface" />
      </div>
      <div className="h-96 rounded-2xl border border-line bg-surface" />
    </div>
  );
}
