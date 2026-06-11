"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import SiteHeader from "@/app/components/SiteHeader";
import DateRangeSelector from "@/app/components/DateRangeSelector";
import CategoryPie from "@/app/components/CategoryPie";
import EditTransactionModal, {
  type ModalAccount,
} from "@/app/components/EditTransactionModal";
import MerchantSearchInput from "@/app/components/MerchantSearchInput";
import {
  absMoney0,
  categoryLabel,
  dayShort,
  money0,
  money2,
  monthBounds,
  toIso,
} from "@/lib/format";
import { ALL_CATEGORIES, SPENDING_CATEGORIES } from "@/lib/taxonomy";

type Summary = { income: number; expenses: number; net: number };
type CategoryRow = { category: string; spend: number };
type VendorRow = { vendor: string; spend: number; txns: number };
type Split = { category: string; percent: number };
type TxnRow = {
  id: number;
  occurred_at: string;
  merchant: string;
  merchant_raw: string;
  amount: number;
  account: string;
  category: string | null;
  txn_type: string;
  is_spending: boolean;
  splits: Split[];
};

const SPENDING_SET = new Set<string>(SPENDING_CATEGORIES);

// Round to cents, half away from zero (matches Postgres NUMERIC ROUND, so client
// aggregation lines up with db/queries.sql).
function roundCents(x: number): number {
  return (Math.sign(x) * Math.round(Math.abs(x) * 100)) / 100;
}

// Splits-aware expansion (db/queries.sql query 1): a txn WITHOUT splits yields one
// line under its own category; a txn WITH splits yields one line per split at
// amount × percent/100 and NONE under its parent category.
type SpendLine = {
  txnId: number;
  category: string;
  amount: number;
  is_spending: boolean;
  merchant: string;
};
function toLines(txns: TxnRow[]): SpendLine[] {
  const lines: SpendLine[] = [];
  for (const t of txns) {
    if (t.splits.length === 0) {
      lines.push({
        txnId: t.id,
        category: t.category ?? "uncategorized",
        amount: t.amount,
        is_spending: t.is_spending,
        merchant: t.merchant,
      });
    } else {
      for (const s of t.splits) {
        lines.push({
          txnId: t.id,
          category: s.category,
          amount: roundCents((t.amount * s.percent) / 100),
          is_spending: t.is_spending,
          merchant: t.merchant,
        });
      }
    }
  }
  return lines;
}
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
    // Use the native history API rather than router.replace(). /transactions is
    // statically prerendered in production, and there Next's client router
    // dedupes query-only router.replace() calls to a no-op once the URL already
    // has params — which froze the entire date bar on the first-loaded month.
    // window.history.replaceState is integrated with the App Router (Next 14.1+),
    // so it updates useSearchParams() (and thus the period) reliably in BOTH dev
    // and production.
    window.history.replaceState(null, "", `/transactions?${params.toString()}`);
  }

  // Edit/split + add-expense modal. `add=1` (e.g. from the header button on any
  // page) opens the manual-entry form; row clicks open the editor.
  type ModalState = { mode: "add" } | { mode: "edit"; id: number } | null;
  const [modal, setModal] = useState<ModalState>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const addParam = searchParams.get("add");
  useEffect(() => {
    if (addParam) {
      setModal({ mode: "add" });
      const params = new URLSearchParams(searchParams.toString());
      params.delete("add");
      window.history.replaceState(
        null,
        "",
        `/transactions${params.toString() ? `?${params.toString()}` : ""}`,
      );
    }
    // Only react to the presence of the add flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addParam]);

  // Section A — review backlog. All-time, independent of filters.
  const [review, setReview] = useState<ReviewRow[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);

  useEffect(() => {
    fetchJson<ReviewRow[]>("/api/review")
      .then(setReview)
      .catch(() => setReview([]));
    fetchJson<Account[]>("/api/accounts")
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, [refreshKey]);

  // Sections C–E. We load ALL transactions for the period ONCE (date only) and
  // derive every widget — summary, pie, top categories, top vendors, the table —
  // from the same client-filtered set. That guarantees the numbers can never
  // drift between the table and the widgets. Our dataset is small (~1300/yr).
  const [txns, setTxns] = useState<TxnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showNonSpending, setShowNonSpending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const periodQs = new URLSearchParams({ start, end }).toString();
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const t = await fetchJson<TxnRow[]>(`/api/transactions?${periodQs}`);
        if (cancelled) return;
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
  }, [start, end, refreshKey]);

  // Resolve the account filter (stored as id) to a name for client-side matching.
  const accountName = useMemo(() => {
    if (!account) return null;
    if (/^\d+$/.test(account)) {
      return accounts.find((a) => String(a.id) === account)?.name ?? null;
    }
    return account;
  }, [account, accounts]);

  // Transaction-level filters (everything EXCEPT category). The category filter is
  // applied splits-aware below, since a split txn belongs to several categories.
  const baseFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return txns.filter((t) => {
      if (accountName && t.account !== accountName) return false;
      if (
        q &&
        !t.merchant.toLowerCase().includes(q) &&
        !t.merchant_raw.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [txns, accountName, search]);

  // Splits-aware spend lines (db/queries.sql query 1): split txns contribute to
  // each split category, never their parent category. Drives all per-category and
  // per-vendor spend rollups so splits are reflected everywhere.
  const baseLines = useMemo(() => toLines(baseFiltered), [baseFiltered]);
  const activeLines = useMemo(
    () => (category ? baseLines.filter((l) => l.category === category) : baseLines),
    [baseLines, category],
  );

  // Income/Expenses/Net headline: parent-level (splitting only reallocates a
  // transaction's spend across categories — it never changes the period total).
  const summary: Summary = useMemo(() => {
    let income = 0;
    let expenses = 0;
    for (const t of baseFiltered) {
      if (t.category === "income" || t.category === "misc_income") {
        income += t.amount;
      }
      if (t.is_spending) expenses += -t.amount;
    }
    return { income, expenses, net: income - expenses };
  }, [baseFiltered]);

  // Splits-aware spend for the selected category (the correct "this category"
  // number even when a transaction is only partly in it).
  const categorySpend = useMemo(
    () =>
      activeLines.reduce((s, l) => (l.is_spending ? s + -l.amount : s), 0),
    [activeLines],
  );

  const categoryAgg: CategoryRow[] = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of activeLines) {
      if (!l.is_spending) continue;
      m.set(l.category, (m.get(l.category) ?? 0) + -l.amount);
    }
    return [...m.entries()]
      .map(([cat, spend]) => ({ category: cat, spend }))
      .sort((a, b) => b.spend - a.spend);
  }, [activeLines]);

  // Vendors: splits-aware portions (a split txn's lines sum back to its parent
  // total, so unfiltered totals are unchanged; within a category we see just that
  // category's share per vendor). txn count is distinct transactions, not lines.
  const vendorAgg: VendorRow[] = useMemo(() => {
    const m = new Map<string, { spend: number; ids: Set<number> }>();
    for (const l of activeLines) {
      if (!l.is_spending) continue;
      const cur = m.get(l.merchant) ?? { spend: 0, ids: new Set<number>() };
      cur.spend += -l.amount;
      cur.ids.add(l.txnId);
      m.set(l.merchant, cur);
    }
    return [...m.entries()]
      .map(([vendor, v]) => ({ vendor, spend: v.spend, txns: v.ids.size }))
      .sort((a, b) => b.spend - a.spend);
  }, [activeLines]);

  // Pie drills down: by category when unfiltered, by vendor within a category.
  const pieItems = useMemo(() => {
    if (category) {
      return vendorAgg.map((v) => ({ name: v.vendor, value: v.spend }));
    }
    return categoryAgg.map((c) => ({
      name: categoryLabel(c.category),
      value: c.spend,
    }));
  }, [category, vendorAgg, categoryAgg]);

  // Table rows: a transaction belongs to the selected category if its own category
  // matches OR (when split) any of its split lines match.
  const filtered = useMemo(() => {
    if (!category) return baseFiltered;
    return baseFiltered.filter((t) =>
      t.splits.length === 0
        ? t.category === category
        : t.splits.some((s) => s.category === category),
    );
  }, [baseFiltered, category]);

  // When narrowing by a (spending) category or a vendor, transfers/refunds just
  // clutter the table — default to spending rows, with a toggle to reveal them.
  const restrictToSpending =
    (category !== "" && SPENDING_SET.has(category)) || search.trim() !== "";
  const hiddenNonSpending = useMemo(
    () =>
      restrictToSpending ? filtered.filter((t) => !t.is_spending).length : 0,
    [restrictToSpending, filtered],
  );
  const tableRows = useMemo(() => {
    if (restrictToSpending && !showNonSpending) {
      return filtered.filter((t) => t.is_spending);
    }
    return filtered;
  }, [filtered, restrictToSpending, showNonSpending]);

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

      <ToReviewSection
        review={review}
        onOpen={(id) => setModal({ mode: "edit", id })}
      />

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
          <PeriodSummary
            summary={summary}
            category={category}
            categorySpend={categorySpend}
            pieItems={pieItems}
          />
          <TopLists
            categories={categoryAgg}
            vendors={vendorAgg}
            totalSpend={category ? categorySpend : summary.expenses}
          />
          <TransactionList
            rows={tableRows}
            total={filtered.length}
            hiddenNonSpending={
              restrictToSpending && !showNonSpending ? hiddenNonSpending : 0
            }
            showNonSpending={showNonSpending}
            canToggleNonSpending={restrictToSpending && hiddenNonSpending > 0}
            onToggleNonSpending={() => setShowNonSpending((v) => !v)}
            onOpen={(id) => setModal({ mode: "edit", id })}
          />
        </>
      )}

      {modal && (
        <EditTransactionModal
          mode={modal.mode}
          transactionId={modal.mode === "edit" ? modal.id : undefined}
          accounts={accounts as ModalAccount[]}
          onClose={() => setModal(null)}
          onSaved={refresh}
        />
      )}
    </main>
  );
}

function ToReviewSection({
  review,
  onOpen,
}: {
  review: ReviewRow[] | null;
  onOpen: (id: number) => void;
}) {
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
            onClick={() => onOpen(row.id)}
            className="flex cursor-pointer items-center gap-4 px-5 py-3 transition-colors hover:bg-surface-2"
            title="Resolve in the editor"
          >
            <span className="w-14 shrink-0 text-xs text-muted">
              {dayShort(row.occurred_at)}
            </span>
            <span className="min-w-0 flex-1">
              {/* Raw string is prominent here — the clean name is often generic
                  ("Check Paid"), so the bank string is the real categorizing clue. */}
              <span className="block truncate font-medium text-ink">
                {row.merchant_raw}
              </span>
              {row.display_name &&
                row.display_name.toLowerCase() !==
                  row.merchant_raw.toLowerCase() && (
                  <span className="block truncate text-xs text-muted">
                    {row.display_name}
                  </span>
                )}
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

        <MerchantSearchInput
          value={search}
          onChange={onSearch}
          className="ml-auto w-full max-w-56"
        />
      </div>
    </section>
  );
}

function PeriodSummary({
  summary,
  category,
  categorySpend,
  pieItems,
}: {
  summary: Summary;
  category: string;
  categorySpend: number;
  pieItems: { name: string; value: number }[];
}) {
  const positive = summary.net >= 0;
  const filteredToCategory = category !== "";

  // Headline differs by mode: a single category shows its (splits-aware) spend;
  // otherwise the period's income / expenses / net.
  const left = filteredToCategory ? (
    <div className="flex flex-col justify-center gap-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">
        {categoryLabel(category)}
      </p>
      <p className="money text-4xl font-semibold text-ink">
        {money0(categorySpend)}
      </p>
      <p className="text-sm text-muted">spent this period</p>
    </div>
  ) : (
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
          style={{ color: positive ? "var(--color-pos)" : "var(--color-neg)" }}
        >
          {positive ? "+" : "−"}
          {absMoney0(summary.net)}
        </p>
        <p
          className="mt-0.5 text-sm font-medium"
          style={{ color: positive ? "var(--color-pos)" : "var(--color-neg)" }}
        >
          {positive ? "Saved" : "Overspent"} {absMoney0(summary.net)} this
          period
        </p>
      </div>
    </div>
  );

  return (
    <section className="mt-6 grid grid-cols-1 gap-6 rounded-2xl border border-line bg-surface p-5 sm:p-6 lg:grid-cols-2">
      {left}

      <div className="flex items-center">
        <div className="w-full">
          <h2 className="mb-3 text-base font-semibold text-ink">
            {filteredToCategory
              ? `${categoryLabel(category)} by vendor`
              : "Spending by category"}
          </h2>
          <CategoryPie
            items={pieItems}
            emptyLabel={
              filteredToCategory
                ? "No spending for this category."
                : "No spending in this period."
            }
          />
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

type SortKey = "date" | "amount";
type SortDir = "asc" | "desc";

function TransactionList({
  rows,
  total,
  hiddenNonSpending,
  showNonSpending,
  canToggleNonSpending,
  onToggleNonSpending,
  onOpen,
}: {
  rows: TxnRow[];
  total: number;
  hiddenNonSpending: number;
  showNonSpending: boolean;
  canToggleNonSpending: boolean;
  onToggleNonSpending: () => void;
  onOpen: (id: number) => void;
}) {
  // Client-side sort over the already-loaded period rows — no extra API calls.
  // Default matches the API's order: newest first.
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Sensible first click: newest first for date, biggest first for amount.
      setSortDir("desc");
    }
  }

  const sortedRows = useMemo(() => {
    const sign = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      let cmp: number;
      if (sortKey === "amount") {
        // Rank by spend magnitude so a -$2,000 expense outranks a -$10 one,
        // regardless of sign.
        cmp = Math.abs(a.amount) - Math.abs(b.amount);
      } else {
        cmp = a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0;
      }
      // Stable tiebreaker (and matches the API's secondary id ordering).
      if (cmp === 0) cmp = a.id - b.id;
      return cmp * sign;
    });
  }, [rows, sortKey, sortDir]);

  // Net of the rows currently shown (after search/filter) — e.g. total spent
  // with a vendor over the period when the search box is narrowing the list.
  const totalAmount = useMemo(
    () => rows.reduce((sum, t) => sum + t.amount, 0),
    [rows],
  );

  const arrow = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? "↑" : "↓") : "";

  const sortableTh =
    "cursor-pointer select-none font-semibold transition-colors hover:text-ink";

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 className="text-base font-semibold text-ink">Transactions</h2>
        <div className="flex items-center gap-3">
          {canToggleNonSpending && (
            <button
              type="button"
              onClick={onToggleNonSpending}
              className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-line-strong hover:text-ink"
            >
              {showNonSpending
                ? "Hide transfers & refunds"
                : `Show transfers & refunds${
                    hiddenNonSpending ? ` (${hiddenNonSpending})` : ""
                  }`}
            </button>
          )}
          <span className="text-xs text-muted">
            {rows.length === total
              ? `${total} in period`
              : `${rows.length} of ${total}`}
          </span>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyList label="No transactions for this period and filters." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-muted">
                <th
                  className={`px-5 py-2 ${sortableTh} ${sortKey === "date" ? "text-ink" : ""}`}
                  onClick={() => toggleSort("date")}
                  aria-sort={
                    sortKey === "date"
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  Date <span className="text-accent">{arrow("date")}</span>
                </th>
                <th className="px-3 py-2 font-semibold">Merchant</th>
                <th className="px-3 py-2 font-semibold">Account</th>
                <th className="px-3 py-2 font-semibold">Category</th>
                <th className="px-3 py-2 font-semibold">Type</th>
                <th
                  className={`px-5 py-2 text-right ${sortableTh} ${sortKey === "amount" ? "text-ink" : ""}`}
                  onClick={() => toggleSort("amount")}
                  aria-sort={
                    sortKey === "amount"
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <span className="text-accent">{arrow("amount")}</span> Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => onOpen(t.id)}
                  title={`${t.merchant_raw} — open editor`}
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
            <tfoot>
              <tr className="border-t border-line-strong bg-surface-2/40">
                <td
                  className="px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted"
                  colSpan={5}
                >
                  Total · {rows.length} shown
                </td>
                <td
                  className="money whitespace-nowrap px-5 py-2.5 text-right font-semibold"
                  style={{
                    color:
                      totalAmount >= 0
                        ? "var(--color-pos)"
                        : "var(--color-ink)",
                  }}
                >
                  {money2(totalAmount)}
                </td>
              </tr>
            </tfoot>
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
