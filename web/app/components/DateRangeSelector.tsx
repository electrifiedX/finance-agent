"use client";

import { useState } from "react";
import { monthBounds } from "@/lib/format";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export default function DateRangeSelector({
  start,
  end,
  onChange,
}: {
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
}) {
  const parsedYear = Number.parseInt(start.slice(0, 4), 10);
  const year = Number.isFinite(parsedYear)
    ? parsedYear
    : new Date().getFullYear();

  const fullStart = `${year}-01-01`;
  const fullEnd = `${year}-12-31`;
  const isFullYear = start === fullStart && end === fullEnd;

  let activeMonth = -1;
  for (let m = 0; m < 12; m++) {
    const b = monthBounds(`${year}-${pad(m + 1)}-01`);
    if (b.start === start && b.end === end) {
      activeMonth = m;
      break;
    }
  }

  const isCustomRange = !isFullYear && activeMonth === -1;
  const [showCustom, setShowCustom] = useState(false);
  const customOpen = showCustom || isCustomRange;

  const base =
    "rounded-lg border px-2.5 py-1.5 text-sm font-medium transition-colors";
  const idle =
    "border-line text-muted hover:border-line-strong hover:text-ink";
  const on = "border-accent/50 bg-accent/15 text-ink";

  function selectMonth(m: number) {
    const b = monthBounds(`${year}-${pad(m + 1)}-01`);
    setShowCustom(false);
    onChange(b.start, b.end);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {MONTHS.map((label, m) => (
          <button
            key={label}
            type="button"
            onClick={() => selectMonth(m)}
            className={`${base} ${activeMonth === m ? on : idle}`}
          >
            {label}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <button
          type="button"
          onClick={() => {
            setShowCustom(false);
            onChange(fullStart, fullEnd);
          }}
          className={`${base} ${isFullYear ? on : idle}`}
        >
          {year}
        </button>
        <button
          type="button"
          onClick={() => setShowCustom((v) => !v)}
          className={`${base} ${customOpen ? on : idle}`}
        >
          Custom
        </button>
      </div>

      {customOpen && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <label className="flex items-center gap-2">
            <span>From</span>
            <input
              type="date"
              value={start}
              max={end}
              onChange={(e) => onChange(e.target.value || start, end)}
              className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-ink outline-none transition-colors hover:border-line-strong focus:border-accent"
            />
          </label>
          <label className="flex items-center gap-2">
            <span>To</span>
            <input
              type="date"
              value={end}
              min={start}
              onChange={(e) => onChange(start, e.target.value || end)}
              className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-ink outline-none transition-colors hover:border-line-strong focus:border-accent"
            />
          </label>
        </div>
      )}
    </div>
  );
}
