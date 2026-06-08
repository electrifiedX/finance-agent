import { NextResponse } from "next/server";

// Wide-open defaults so a route still works without an explicit range; the
// frontend normally passes start/end. BETWEEN in db/queries.sql is inclusive.
const MIN_DATE = "0001-01-01";
const MAX_DATE = "9999-12-31";

export function getDateRange(searchParams: URLSearchParams): {
  start: string;
  end: string;
} {
  return {
    start: searchParams.get("start") || MIN_DATE,
    end: searchParams.get("end") || MAX_DATE,
  };
}

// pg returns NUMERIC/REAL columns as strings to preserve precision. The
// dashboard wants real numbers for charts/formatting, so coerce known fields.
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

export function jsonError(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : "Internal error";
  return NextResponse.json({ error: message }, { status: 500 });
}
