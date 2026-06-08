"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { money0 } from "@/lib/format";

// Pre-labeled, pre-aggregated items (name + value). The caller decides what the
// slices mean — categories when unfiltered, vendors when drilled into a category.
export type PieItem = { name: string; value: number };

// Decorative, distinguishable hues for the slices. Deliberately NOT the pos/neg
// green/red tokens (those are reserved for money direction), led by the sand accent.
const COLORS = [
  "#d8a85f",
  "#6fa8dc",
  "#b48ead",
  "#7fc8a9",
  "#e0916a",
  "#9aa7b8",
  "#cbb26a",
  "#88b0d4",
];

const TOP = 7;

type Slice = { name: string; value: number };

function PieTooltip({
  active,
  payload,
  total,
}: {
  active?: boolean;
  payload?: { payload: Slice }[];
  total: number;
}) {
  if (!active || !payload?.length) return null;
  const slice = payload[0].payload;
  const pct = total > 0 ? Math.round((slice.value / total) * 100) : 0;
  return (
    <div className="rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-xs shadow-xl">
      <div className="font-semibold text-ink">{slice.name}</div>
      <div className="mt-1 flex items-center justify-between gap-4 text-muted">
        <span className="money text-ink">{money0(slice.value)}</span>
        <span>{pct}%</span>
      </div>
    </div>
  );
}

export default function CategoryPie({
  items,
  emptyLabel = "No spending in this period.",
}: {
  items: PieItem[];
  emptyLabel?: string;
}) {
  const positive = items
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);

  if (positive.length === 0) {
    return (
      <div className="flex h-52 items-center justify-center text-sm text-muted">
        {emptyLabel}
      </div>
    );
  }

  const top = positive.slice(0, TOP);
  const otherTotal = positive
    .slice(TOP)
    .reduce((sum, c) => sum + c.value, 0);

  const data: Slice[] = top.map((c) => ({
    name: c.name,
    value: c.value,
  }));
  if (otherTotal > 0) data.push({ name: "Other", value: otherTotal });

  const total = data.reduce((sum, d) => sum + d.value, 0);

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row">
      <div className="h-48 w-48 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={50}
              outerRadius={80}
              paddingAngle={2}
              stroke="none"
              isAnimationActive={false}
            >
              {data.map((slice, i) => (
                <Cell key={slice.name} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip content={<PieTooltip total={total} />} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <ul className="grid w-full grid-cols-1 gap-1.5 text-sm">
        {data.map((slice, i) => {
          const pct = total > 0 ? Math.round((slice.value / total) * 100) : 0;
          return (
            <li
              key={slice.name}
              className="flex items-center justify-between gap-3"
            >
              <span className="flex min-w-0 items-center gap-2 text-ink-soft">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ background: COLORS[i % COLORS.length] }}
                />
                <span className="truncate">{slice.name}</span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="money text-ink">{money0(slice.value)}</span>
                <span className="w-9 text-right text-muted">{pct}%</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
