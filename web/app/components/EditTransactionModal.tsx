"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ALL_CATEGORIES,
  NONSPENDING_CATEGORIES,
  SPENDING_CATEGORIES,
  TXN_TYPES,
  deriveIsSpending,
} from "@/lib/taxonomy";
import { categoryLabel, money2 } from "@/lib/format";

export type ModalAccount = {
  id: number;
  name: string;
  institution: string | null;
  type: string;
};

type Merchant = {
  id: number;
  display_name: string;
  default_category: string | null;
  locked: boolean;
};

type TemplateLine = { category: string; percent: number };

type Detail = {
  id: number;
  occurred_at: string;
  amount: number;
  category: string | null;
  txn_type: string;
  notes: string | null;
  account_id: number;
  merchant_id: number | null;
  merchant_raw: string;
  merchant: Merchant | null;
  splits: { category: string; percent: number; notes: string | null }[];
  split_template: TemplateLine[] | null;
};

type SplitLine = { category: string; percent: string };

type Props = {
  mode: "add" | "edit";
  transactionId?: number;
  accounts: ModalAccount[];
  onClose: () => void;
  onSaved: () => void;
};

const inputCls =
  "w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-muted hover:border-line-strong focus:border-accent";
const labelCls =
  "block text-xs font-semibold uppercase tracking-wider text-muted";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Largest-remainder rounding (§10): derive each line, then push the leftover
// cent(s) onto the lines with the biggest fractional parts so displayed dollars
// reconcile to the parent exactly.
function deriveDollars(absAmount: number, percents: number[]): number[] {
  const cents = Math.round(absAmount * 100);
  const raw = percents.map((p) => (cents * p) / 100);
  const floored = raw.map((r) => Math.floor(r));
  let remainder = cents - floored.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floored];
  for (let k = 0; k < order.length && remainder > 0; k++) {
    out[order[k].i] += 1;
    remainder--;
  }
  return out.map((c) => c / 100);
}

export default function EditTransactionModal({
  mode,
  transactionId,
  accounts,
  onClose,
  onSaved,
}: Props) {
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form fields.
  const [date, setDate] = useState(todayIso());
  const [amountAbs, setAmountAbs] = useState("");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [category, setCategory] = useState<string>("");
  const [txnType, setTxnType] = useState<string>("sale");
  const [accountId, setAccountId] = useState<number | null>(
    accounts[0]?.id ?? null,
  );
  const [notes, setNotes] = useState("");

  // Merchant.
  const [merchant, setMerchant] = useState<Merchant | null>(null);
  const [merchantRaw, setMerchantRaw] = useState<string>("");
  const [initialCategory, setInitialCategory] = useState<string | null>(null);
  const [applyToMerchant, setApplyToMerchant] = useState(false);

  // Splits.
  const [splitsOn, setSplitsOn] = useState(false);
  const [splits, setSplits] = useState<SplitLine[]>([]);
  const [template, setTemplate] = useState<TemplateLine[] | null>(null);
  const [saveTemplate, setSaveTemplate] = useState(false);

  // Load detail for edit mode.
  useEffect(() => {
    if (mode !== "edit" || transactionId == null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/transactions/${transactionId}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          const b = await res.json().catch(() => null);
          throw new Error(b?.error ?? "Failed to load transaction");
        }
        const d: Detail = await res.json();
        if (cancelled) return;
        setDate(d.occurred_at);
        setAmountAbs(Math.abs(d.amount).toFixed(2));
        setDirection(d.amount < 0 ? "out" : "in");
        setCategory(d.category ?? "");
        setInitialCategory(d.category ?? null);
        setTxnType(d.txn_type);
        setAccountId(d.account_id);
        setNotes(d.notes ?? "");
        setMerchant(d.merchant);
        setMerchantRaw(d.merchant_raw);
        setTemplate(d.split_template);
        if (d.splits.length > 0) {
          setSplitsOn(true);
          setSplits(
            d.splits.map((s) => ({
              category: s.category,
              percent: String(s.percent),
            })),
          );
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, transactionId]);

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const signedAmount = useMemo(() => {
    const n = Number.parseFloat(amountAbs);
    if (!Number.isFinite(n)) return 0;
    return direction === "out" ? -Math.abs(n) : Math.abs(n);
  }, [amountAbs, direction]);

  const absAmount = Math.abs(signedAmount);

  const splitPercents = useMemo(
    () => splits.map((s) => Number.parseFloat(s.percent) || 0),
    [splits],
  );
  const splitTotal = useMemo(
    () => splitPercents.reduce((a, b) => a + b, 0),
    [splitPercents],
  );
  const splitDollars = useMemo(
    () => deriveDollars(absAmount, splitPercents),
    [absAmount, splitPercents],
  );
  const splitsValid = Math.abs(splitTotal - 100) < 0.01 && splits.length >= 2;

  const isSpending = deriveIsSpending(category || null, txnType);
  const categoryChanged =
    mode === "add" ? !!category : category !== (initialCategory ?? "");
  const canLearn = !!merchant && !!category && categoryChanged && !splitsOn;

  function pickMerchant(m: Merchant) {
    setMerchant(m);
    // Prefill an empty category from the merchant's locked default, as a hint.
    if (!category && m.default_category) setCategory(m.default_category);
  }

  function applyTemplate(lines: TemplateLine[]) {
    setSplitsOn(true);
    setSplits(
      lines.map((l) => ({ category: l.category, percent: String(l.percent) })),
    );
  }

  function addSplitLine() {
    setSplits((prev) => [
      ...prev,
      { category: category || SPENDING_CATEGORIES[0], percent: "" },
    ]);
  }

  function toggleSplits() {
    setSplitsOn((on) => {
      const next = !on;
      if (next && splits.length === 0) {
        // Seed two lines: the current category at 100, plus an empty second line.
        setSplits([
          { category: category || SPENDING_CATEGORIES[0], percent: "100" },
          { category: "", percent: "" },
        ]);
      }
      return next;
    });
  }

  async function handleSave() {
    setError(null);

    if (!Number.isFinite(signedAmount) || amountAbs.trim() === "") {
      setError("Enter an amount.");
      return;
    }
    if (accountId == null) {
      setError("Pick an account.");
      return;
    }
    if (mode === "add" && !merchant) {
      setError("Pick or create a merchant.");
      return;
    }
    if (splitsOn && !splitsValid) {
      setError(
        `Split percentages must sum to exactly 100 (currently ${splitTotal.toFixed(
          2,
        )}%).`,
      );
      return;
    }

    const splitPayload = splitsOn
      ? splits.map((s) => ({
          category: s.category,
          percent: Number.parseFloat(s.percent) || 0,
        }))
      : [];

    setSaving(true);
    try {
      let res: Response;
      if (mode === "edit") {
        res = await fetch(`/api/transactions/${transactionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            occurred_at: date,
            amount: signedAmount,
            category: category || null,
            txn_type: txnType,
            account_id: accountId,
            notes: notes.trim() ? notes : null,
            merchant_id: merchant?.id ?? null,
            apply_to_merchant: canLearn && applyToMerchant,
            splits: splitPayload,
            save_split_template: splitsOn && splitsValid && saveTemplate,
          }),
        });
      } else {
        res = await fetch(`/api/transactions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            occurred_at: date,
            amount: signedAmount,
            account_id: accountId,
            category: category || null,
            txn_type: txnType,
            notes: notes.trim() ? notes : null,
            merchant_id: merchant?.id ?? null,
            apply_to_merchant: canLearn && applyToMerchant,
            splits: splitsOn ? splitPayload : null,
            save_split_template: splitsOn && splitsValid && saveTemplate,
          }),
        });
      }
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(b?.error ?? "Save failed");
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (mode !== "edit" || transactionId == null) return;
    if (
      !window.confirm(
        "Remove this transaction? It is soft-deleted (kept for audit) and drops out of all totals.",
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/transactions/${transactionId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(b?.error ?? "Delete failed");
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="my-8 w-full max-w-2xl rounded-2xl border border-line-strong bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="font-display text-xl font-medium text-ink">
            {mode === "add" ? "Add expense" : "Edit transaction"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="px-6 py-16 text-center text-sm text-muted">
            Loading…
          </div>
        ) : (
          <div className="space-y-5 px-6 py-5">
            {/* Merchant / vendor */}
            <MerchantField
              merchant={merchant}
              merchantRaw={merchantRaw}
              onPick={pickMerchant}
              onClear={() => setMerchant(null)}
            />

            {/* Amount + direction */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="amount">
                  Amount
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    id="amount"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={amountAbs}
                    onChange={(e) => setAmountAbs(e.target.value)}
                    placeholder="0.00"
                    className={`money ${inputCls}`}
                  />
                  <div className="flex shrink-0 overflow-hidden rounded-lg border border-line">
                    {(["out", "in"] as const).map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setDirection(d)}
                        className={`px-3 py-2 text-xs font-semibold transition-colors ${
                          direction === d
                            ? d === "out"
                              ? "bg-neg-soft text-neg"
                              : "bg-pos-soft text-pos"
                            : "text-muted hover:text-ink"
                        }`}
                      >
                        {d === "out" ? "Out" : "In"}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted">
                  Stored as{" "}
                  <span
                    className="money"
                    style={{
                      color:
                        signedAmount < 0
                          ? "var(--color-ink-soft)"
                          : "var(--color-pos)",
                    }}
                  >
                    {money2(signedAmount)}
                  </span>{" "}
                  — edit freely (e.g. add a tip the feed missed).
                </p>
              </div>

              <div>
                <label className={labelCls} htmlFor="date">
                  Date
                </label>
                <input
                  id="date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className={`mt-1 ${inputCls}`}
                />
              </div>
            </div>

            {/* Account + type */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="account">
                  Account
                </label>
                <select
                  id="account"
                  value={accountId ?? ""}
                  onChange={(e) =>
                    setAccountId(
                      e.target.value ? Number.parseInt(e.target.value, 10) : null,
                    )
                  }
                  className={`mt-1 ${inputCls}`}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor="type">
                  Type
                </label>
                <select
                  id="type"
                  value={txnType}
                  onChange={(e) => setTxnType(e.target.value)}
                  className={`mt-1 ${inputCls}`}
                >
                  {TXN_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {categoryLabel(t)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Category (single) */}
            {!splitsOn && (
              <div>
                <label className={labelCls} htmlFor="category">
                  Category
                </label>
                <select
                  id="category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className={`mt-1 ${inputCls}`}
                >
                  <option value="">Uncategorized…</option>
                  <optgroup label="Spending">
                    {SPENDING_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {categoryLabel(c)}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Non-spending">
                    {NONSPENDING_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {categoryLabel(c)}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <p className="mt-1 text-xs text-muted">
                  {isSpending
                    ? "Counts toward spending."
                    : "Excluded from spending totals."}
                </p>

                {canLearn && (
                  <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-ink-soft">
                    <input
                      type="checkbox"
                      checked={applyToMerchant}
                      onChange={(e) => setApplyToMerchant(e.target.checked)}
                      className="mt-0.5 accent-[var(--color-accent)]"
                    />
                    <span>
                      Always categorize{" "}
                      <span className="font-medium text-ink">
                        {merchant?.display_name}
                      </span>{" "}
                      as{" "}
                      <span className="font-medium text-ink">
                        {categoryLabel(category)}
                      </span>{" "}
                      going forward
                      <span className="block text-xs text-muted">
                        Sets the merchant default + locks it. One-offs: leave
                        unchecked.
                      </span>
                    </span>
                  </label>
                )}
              </div>
            )}

            {/* Splits */}
            <SplitEditor
              splitsOn={splitsOn}
              splits={splits}
              splitDollars={splitDollars}
              splitTotal={splitTotal}
              splitsValid={splitsValid}
              template={template}
              saveTemplate={saveTemplate}
              merchantSelected={!!merchant}
              onToggle={toggleSplits}
              onApplyTemplate={applyTemplate}
              onAddLine={addSplitLine}
              onChangeLine={(i, patch) =>
                setSplits((prev) =>
                  prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
                )
              }
              onRemoveLine={(i) =>
                setSplits((prev) => prev.filter((_, idx) => idx !== i))
              }
              onSaveTemplateChange={setSaveTemplate}
            />

            {/* Notes */}
            <div>
              <label className={labelCls} htmlFor="notes">
                Notes
              </label>
              <textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="What was this? (helps for ambiguous checks / Venmo)"
                className={`mt-1 resize-y ${inputCls}`}
              />
            </div>

            {error && (
              <div className="rounded-lg border border-neg/40 bg-neg-soft/40 px-3 py-2 text-sm text-neg">
                {error}
              </div>
            )}
          </div>
        )}

        {!loading && (
          <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
            {mode === "edit" ? (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                className="rounded-lg border border-neg/40 px-3 py-2 text-sm font-medium text-neg transition-colors hover:bg-neg-soft/40 disabled:opacity-50"
              >
                Delete
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-ink disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || (splitsOn && !splitsValid)}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-[#1a130a] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Saving…" : mode === "add" ? "Add expense" : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Searchable merchant field — the duplicate-merchant guard. Existing matches are
// the primary path; "create new vendor" is explicit and visually separated.
// ---------------------------------------------------------------------------
function MerchantField({
  merchant,
  merchantRaw,
  onPick,
  onClear,
}: {
  merchant: Merchant | null;
  merchantRaw: string;
  onPick: (m: Merchant) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Merchant[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/merchants?q=${encodeURIComponent(q)}`, {
        cache: "no-store",
      });
      const data: Merchant[] = res.ok ? await res.json() : [];
      setResults(data);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => runSearch(query.trim()), 180);
    return () => clearTimeout(t);
  }, [query, open, runSearch]);

  const exactMatch = results.some(
    (r) => r.display_name.toLowerCase() === query.trim().toLowerCase(),
  );
  const canCreate = query.trim().length >= 2 && !exactMatch;

  async function createVendor() {
    const name = query.trim();
    if (!name) return;
    setCreating(true);
    try {
      const res = await fetch(`/api/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: name }),
      });
      if (res.ok) {
        const m: Merchant = await res.json();
        onPick(m);
        setQuery("");
        setOpen(false);
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <label className={labelCls} htmlFor="merchant">
        Merchant / vendor
      </label>

      {merchant ? (
        <div className="mt-1 flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2">
          <div className="min-w-0">
            <span className="block truncate font-medium text-ink">
              {merchant.display_name}
            </span>
            {merchant.locked && merchant.default_category && (
              <span className="text-xs text-muted">
                Default: {categoryLabel(merchant.default_category)} · locked
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              onClear();
              setQuery("");
              setOpen(true);
            }}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-surface"
          >
            Change
          </button>
        </div>
      ) : (
        <div className="relative mt-1">
          <input
            id="merchant"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              blurTimer.current = setTimeout(() => setOpen(false), 150);
            }}
            placeholder="Search existing vendors…"
            className={inputCls}
            autoComplete="off"
          />
          {open && (
            <div
              className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-line-strong bg-surface-2 shadow-xl"
              onMouseDown={(e) => {
                // Keep focus so the click registers before blur closes the list.
                e.preventDefault();
                if (blurTimer.current) clearTimeout(blurTimer.current);
              }}
            >
              {loading ? (
                <div className="px-3 py-2 text-xs text-muted">Searching…</div>
              ) : results.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted">
                  {query.trim()
                    ? "No matching vendors."
                    : "Start typing to search vendors."}
                </div>
              ) : (
                <ul>
                  {results.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onPick(m);
                          setQuery("");
                          setOpen(false);
                        }}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-surface"
                      >
                        <span className="min-w-0 truncate text-ink">
                          {m.display_name}
                        </span>
                        {m.default_category && (
                          <span className="shrink-0 text-xs text-muted">
                            {categoryLabel(m.default_category)}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {canCreate && (
                <div className="border-t border-line">
                  <button
                    type="button"
                    onClick={createVendor}
                    disabled={creating}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-accent transition-colors hover:bg-surface disabled:opacity-50"
                  >
                    <span className="text-base leading-none">+</span>
                    {creating ? "Creating…" : `Create new vendor “${query.trim()}”`}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {merchantRaw && (
        <p className="mt-1 truncate text-xs text-muted/80">
          Original: {merchantRaw}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Split editor — percentage lines that must sum to 100, live derived dollars,
// per-merchant template offered/saved.
// ---------------------------------------------------------------------------
function SplitEditor({
  splitsOn,
  splits,
  splitDollars,
  splitTotal,
  splitsValid,
  template,
  saveTemplate,
  merchantSelected,
  onToggle,
  onApplyTemplate,
  onAddLine,
  onChangeLine,
  onRemoveLine,
  onSaveTemplateChange,
}: {
  splitsOn: boolean;
  splits: SplitLine[];
  splitDollars: number[];
  splitTotal: number;
  splitsValid: boolean;
  template: TemplateLine[] | null;
  saveTemplate: boolean;
  merchantSelected: boolean;
  onToggle: () => void;
  onApplyTemplate: (lines: TemplateLine[]) => void;
  onAddLine: () => void;
  onChangeLine: (i: number, patch: Partial<SplitLine>) => void;
  onRemoveLine: (i: number) => void;
  onSaveTemplateChange: (v: boolean) => void;
}) {
  const remaining = 100 - splitTotal;

  return (
    <div className="rounded-xl border border-line bg-surface-2/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink">Split across categories</p>
          <p className="text-xs text-muted">
            Percentages summing to 100 — dollars derived live.
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={splitsOn}
            onChange={onToggle}
            className="accent-[var(--color-accent)]"
          />
          Split
        </label>
      </div>

      {splitsOn && (
        <div className="mt-4 space-y-3">
          {template && (
            <button
              type="button"
              onClick={() => onApplyTemplate(template)}
              className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20"
            >
              Use saved split (
              {template.map((l) => `${l.percent}% ${categoryLabel(l.category)}`).join(", ")}
              )
            </button>
          )}

          <div className="space-y-2">
            {splits.map((line, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  value={line.category}
                  onChange={(e) => onChangeLine(i, { category: e.target.value })}
                  className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
                >
                  <option value="">Category…</option>
                  {ALL_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {categoryLabel(c)}
                    </option>
                  ))}
                </select>
                <div className="flex items-center">
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    max="100"
                    value={line.percent}
                    onChange={(e) =>
                      onChangeLine(i, { percent: e.target.value })
                    }
                    placeholder="0"
                    className="money w-16 rounded-l-lg border border-line bg-surface px-2 py-1.5 text-right text-sm text-ink outline-none focus:border-accent"
                  />
                  <span className="rounded-r-lg border border-l-0 border-line bg-surface px-1.5 py-1.5 text-xs text-muted">
                    %
                  </span>
                </div>
                <span className="money w-20 shrink-0 text-right text-xs text-ink-soft">
                  {money2(splitDollars[i] ?? 0)}
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveLine(i)}
                  className="shrink-0 rounded-md px-1.5 py-1 text-muted transition-colors hover:text-neg"
                  aria-label="Remove split line"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={onAddLine}
              className="rounded-md px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-surface"
            >
              + Add line
            </button>
            <span
              className="text-xs font-semibold"
              style={{
                color: splitsValid
                  ? "var(--color-pos)"
                  : "var(--color-neg)",
              }}
            >
              {splitTotal.toFixed(2)}% of 100
              {!splitsValid &&
                splits.length >= 2 &&
                ` (${remaining > 0 ? "+" : ""}${remaining.toFixed(2)} to go)`}
            </span>
          </div>

          {merchantSelected && (
            <label className="flex cursor-pointer items-center gap-2 border-t border-line pt-3 text-sm text-muted">
              <input
                type="checkbox"
                checked={saveTemplate}
                disabled={!splitsValid}
                onChange={(e) => onSaveTemplateChange(e.target.checked)}
                className="accent-[var(--color-accent)] disabled:opacity-50"
              />
              Save as this merchant’s split template
            </label>
          )}
        </div>
      )}
    </div>
  );
}
