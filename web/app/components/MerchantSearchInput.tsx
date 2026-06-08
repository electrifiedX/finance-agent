"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { categoryLabel } from "@/lib/format";

type Merchant = {
  id: number;
  display_name: string;
  default_category: string | null;
  locked: boolean;
};

// A typeahead over EXISTING merchants (same /api/merchants?q= source as the edit
// modal). Free text is still allowed — picking a result just fills the box — so it
// keeps driving the page's client-side row filter. Empty query shows the most-used
// merchants so the list is never blank.
export default function MerchantSearchInput({
  value,
  onChange,
  placeholder = "Search merchant…",
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Merchant[]>([]);
  const [loading, setLoading] = useState(false);
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
    const t = setTimeout(() => runSearch(value.trim()), 180);
    return () => clearTimeout(t);
  }, [value, open, runSearch]);

  return (
    <div className={`relative ${className}`}>
      <input
        type="search"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-ink outline-none transition-colors placeholder:text-muted hover:border-line-strong focus:border-accent"
      />

      {open && (
        <div
          className="absolute right-0 z-20 mt-1 max-h-64 w-72 max-w-[80vw] overflow-y-auto rounded-lg border border-line-strong bg-surface-2 shadow-xl"
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
              No matching vendors.
            </div>
          ) : (
            <ul>
              {results.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(m.display_name);
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
        </div>
      )}
    </div>
  );
}
