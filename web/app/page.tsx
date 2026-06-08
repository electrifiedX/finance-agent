"use client";

import { useEffect, useMemo, useState } from "react";
import MonthlyChart, { type ChartPoint } from "@/app/components/MonthlyChart";
import SiteHeader from "@/app/components/SiteHeader";
import { absMoney0, categoryLabel, money0, monthShort } from "@/lib/format";

type Summary = { income: number; expenses: number; net: number };
type MonthlyRow = { month: string; income: number; expenses: number; net: number };
type CategoryRow = { category: string; spend: number };
type SeriesRow = { month: string; spend: number };

const ALL = "all";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed: ${url}`);
  }
  return res.json() as Promise<T>;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

type Trend = { text: string; tone: "pos" | "neg" | "muted" };

// Describe the trailing run in a series. `higherIsBetter` flips the meaning of
// "good": for net, up is good; for category spend, down is good (we're saving).
function computeTrend(
  values: number[],
  higherIsBetter: boolean,
  noun: string,
): Trend | null {
  if (values.length < 2) return null;
  const deltas = values.slice(1).map((v, i) => v - values[i]);
  const eps = 50; // ignore sub-$50 wiggle as "flat"
  const last = deltas[deltas.length - 1];
  if (Math.abs(last) < eps) {
    return { text: `${noun} holding steady month over month`, tone: "muted" };
  }
  const rising = last > 0;
  let run = 0;
  for (let i = deltas.length - 1; i >= 0; i--) {
    const matches = rising ? deltas[i] > eps : deltas[i] < -eps;
    if (matches) run++;
    else break;
  }
  const good = rising === higherIsBetter;
  const verb = higherIsBetter
    ? rising
      ? "improving"
      : "declining"
    : rising
      ? "rising"
      : "falling";
  const span = run >= 2 ? `${run} months running` : "this month";
  return { text: `${noun} ${verb} ${span}`, tone: good ? "pos" : "neg" };
}

export default function OverviewPage() {
  const year = new Date().getFullYear();
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;

  const [summary, setSummary] = useState<Summary | null>(null);
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [selected, setSelected] = useState<string>(ALL);
  const [series, setSeries] = useState<SeriesRow[] | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, m, c] = await Promise.all([
          fetchJson<Summary>(`/api/summary?start=${start}&end=${end}`),
          fetchJson<MonthlyRow[]>(`/api/monthly?start=${start}&end=${end}`),
          fetchJson<CategoryRow[]>(`/api/categories?start=${start}&end=${end}`),
        ]);
        if (cancelled) return;
        setSummary(s);
        setMonthly(m);
        setCategories(c);
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
  }, [start, end]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (selected === ALL) {
        if (!cancelled) setSeries(null);
        return;
      }
      setSeriesLoading(true);
      try {
        const data = await fetchJson<SeriesRow[]>(
          `/api/category-series?category=${encodeURIComponent(selected)}&start=${start}&end=${end}`,
        );
        if (!cancelled) setSeries(data);
      } catch {
        if (!cancelled) setSeries([]);
      } finally {
        if (!cancelled) setSeriesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, start, end]);

  const isCategoryMode = selected !== ALL;

  const points: ChartPoint[] = useMemo(() => {
    if (!isCategoryMode) {
      return monthly.map((m) => ({
        month: m.month,
        label: monthShort(m.month),
        value: m.expenses,
        net: m.net,
      }));
    }
    const seriesMap = new Map((series ?? []).map((r) => [r.month, r.spend]));
    return monthly.map((m) => ({
      month: m.month,
      label: monthShort(m.month),
      value: seriesMap.get(m.month) ?? 0,
      net: null,
    }));
  }, [isCategoryMode, monthly, series]);

  const average = useMemo(() => mean(points.map((p) => p.value)), [points]);

  const trend = useMemo(() => {
    if (!isCategoryMode) {
      return computeTrend(
        monthly.map((m) => m.net),
        true,
        "Net",
      );
    }
    return computeTrend(
      points.map((p) => p.value),
      false,
      `${categoryLabel(selected)} spending`,
    );
  }, [isCategoryMode, monthly, points, selected]);

  return (
    <div className="min-h-full bg-background">
      <SiteHeader active="overview" />

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6">
          <h1 className="font-display text-3xl font-medium tracking-tight text-ink">
            How are we doing?
          </h1>
          <p className="mt-1 text-sm text-muted">{year} so far</p>
        </div>

        {error ? (
          <div className="rounded-2xl border border-neg/40 bg-neg-soft/40 px-5 py-4 text-sm text-neg">
            <p className="font-medium">Couldn’t load your numbers</p>
            <p className="mt-1 opacity-90">{error}</p>
          </div>
        ) : loading ? (
          <LoadingState />
        ) : (
          <>
            <HealthStrip summary={summary} year={year} />

            <section className="mt-6 rounded-2xl border border-line bg-surface p-5 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-base font-semibold text-ink">
                    {isCategoryMode
                      ? `${categoryLabel(selected)} by month`
                      : "Monthly spending"}
                  </h2>
                  {trend && (
                    <p className="mt-1 text-sm">
                      <span
                        className="font-medium"
                        style={{ color: `var(--color-${trend.tone})` }}
                      >
                        {trend.text}
                      </span>
                    </p>
                  )}
                </div>

                <label className="flex items-center gap-2 text-sm text-muted">
                  <span className="sr-only sm:not-sr-only">Show</span>
                  <select
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                    className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm font-medium text-ink outline-none transition-colors hover:border-line-strong focus:border-accent"
                  >
                    <option value={ALL}>All expenses</option>
                    {categories.map((c) => (
                      <option key={c.category} value={c.category}>
                        {categoryLabel(c.category)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="mt-4">
                {seriesLoading ? (
                  <div className="flex h-80 items-center justify-center text-sm text-muted">
                    Loading {categoryLabel(selected)}…
                  </div>
                ) : points.length === 0 ? (
                  <div className="flex h-80 items-center justify-center text-sm text-muted">
                    No data for this period yet.
                  </div>
                ) : (
                  <MonthlyChart
                    points={points}
                    colorMode={isCategoryMode ? "accent" : "net"}
                    average={average}
                    valueLabel={
                      isCategoryMode ? categoryLabel(selected) : "Spending"
                    }
                  />
                )}
              </div>

              <p className="mt-3 text-xs text-muted">
                {isCategoryMode
                  ? "Bars show this category’s spend per month."
                  : "Bars show monthly spending; the figure under each month is its net (green saved · red overspent)."}{" "}
                The dashed line marks the average month. Click a bar to see that
                month’s transactions.
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function HealthStrip({
  summary,
  year,
}: {
  summary: Summary | null;
  year: number;
}) {
  if (!summary) return null;
  const net = summary.net;
  const positive = net >= 0;
  const savingsRate =
    summary.income > 0 ? Math.round((net / summary.income) * 100) : null;

  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <StatCard label={`${year} Income`}>
        <span className="money text-3xl font-medium text-ink">
          {money0(summary.income)}
        </span>
      </StatCard>

      <StatCard label={`${year} Expenses`}>
        <span className="money text-3xl font-medium text-ink">
          {money0(summary.expenses)}
        </span>
      </StatCard>

      <StatCard
        label="Net so far"
        highlight={positive ? "pos" : "neg"}
      >
        <span
          className="money text-3xl font-semibold"
          style={{ color: positive ? "var(--color-pos)" : "var(--color-neg)" }}
        >
          {positive ? "+" : "−"}
          {absMoney0(net)}
        </span>
        <p
          className="mt-1 text-sm font-medium"
          style={{ color: positive ? "var(--color-pos)" : "var(--color-neg)" }}
        >
          {positive ? "Saved" : "Overspent"} {absMoney0(net)} this year
          {savingsRate !== null && positive
            ? ` · ${savingsRate}% saved`
            : ""}
        </p>
      </StatCard>
    </section>
  );
}

function StatCard({
  label,
  highlight,
  children,
}: {
  label: string;
  highlight?: "pos" | "neg";
  children: React.ReactNode;
}) {
  const ring =
    highlight === "pos"
      ? "border-pos/30"
      : highlight === "neg"
        ? "border-neg/30"
        : "border-line";
  return (
    <div className={`rounded-2xl border ${ring} bg-surface p-5 sm:p-6`}>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">
        {label}
      </p>
      <div className="mt-3 text-right">{children}</div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="animate-pulse">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 rounded-2xl border border-line bg-surface" />
        ))}
      </div>
      <div className="mt-6 h-96 rounded-2xl border border-line bg-surface" />
    </div>
  );
}
