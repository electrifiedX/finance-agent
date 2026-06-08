// Shared formatting + label helpers for the dashboard UI.

const usd0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const usd2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Whole-dollar money, e.g. $1,240. Used for big headline figures and axes. */
export function money0(value: number): string {
  return usd0.format(Math.round(value));
}

/** Cents-precise money, e.g. $1,240.55. */
export function money2(value: number): string {
  return usd2.format(value);
}

/** Absolute whole-dollar money (sign carried separately by Saved/Overspent). */
export function absMoney0(value: number): string {
  return usd0.format(Math.abs(Math.round(value)));
}

const MONTH_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
});

/** "2026-03-01" -> "Mar". */
export function monthShort(isoDate: string): string {
  return MONTH_FMT.format(new Date(`${isoDate}T00:00:00Z`));
}

const DAY_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** "2026-03-03" -> "Mar 3". Used for transaction-row dates. */
export function dayShort(isoDate: string): string {
  return DAY_FMT.format(new Date(`${isoDate}T00:00:00Z`));
}

/** First and last day (YYYY-MM-DD) of the month containing isoDate. */
export function monthBounds(isoDate: string): { start: string; end: string } {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0));
  return { start: toIso(start), end: toIso(end) };
}

export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Turn a taxonomy key (snake_case) into a readable label. */
export function categoryLabel(key: string): string {
  return key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
