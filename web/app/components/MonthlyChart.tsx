"use client";

import { useRouter } from "next/navigation";
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { absMoney0, money0, monthBounds } from "@/lib/format";

export type ChartPoint = {
  month: string; // YYYY-MM-DD (first of month)
  label: string; // "Mar"
  value: number; // bar height — monthly spend (all expenses or one category)
  net: number | null; // monthly net (null in category mode)
};

const POS = "var(--color-pos)";
const NEG = "var(--color-neg)";
const ACCENT = "var(--color-accent)";

function barFill(point: ChartPoint, colorMode: "net" | "accent"): string {
  if (colorMode === "accent" || point.net === null) return ACCENT;
  return point.net >= 0 ? POS : NEG;
}

type TickProps = {
  x?: number;
  y?: number;
  payload?: { value?: string };
  points: ChartPoint[];
  colorMode: "net" | "accent";
};

// Two-line axis tick: month name, then the color-coded money figure beneath it
// (net in all-expenses mode, category spend in category mode).
function MonthTick({ x = 0, y = 0, payload, points, colorMode }: TickProps) {
  const point = points.find((p) => p.month === payload?.value);
  if (!point) return null;

  const showNet = colorMode === "net" && point.net !== null;
  const figure = showNet ? point.net! : point.value;
  const color = showNet
    ? figure >= 0
      ? POS
      : NEG
    : "var(--color-ink-soft)";

  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={16}
        textAnchor="middle"
        fontSize={12}
        fontWeight={600}
        fill="var(--color-muted)"
      >
        {point.label}
      </text>
      <text
        x={0}
        y={0}
        dy={34}
        textAnchor="middle"
        fontSize={12}
        fontWeight={600}
        fill={color}
        style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
      >
        {showNet
          ? `${figure >= 0 ? "+" : "−"}${absMoney0(figure)}`
          : money0(figure)}
      </text>
    </g>
  );
}

type TooltipPayload = { payload: ChartPoint };

function ChartTooltip({
  active,
  payload,
  valueLabel,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  valueLabel: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-xs shadow-xl">
      <div className="font-semibold text-ink">{point.label}</div>
      <div className="mt-1 flex items-center justify-between gap-4 text-muted">
        <span>{valueLabel}</span>
        <span className="money text-ink">{money0(point.value)}</span>
      </div>
      {point.net !== null && (
        <div className="mt-0.5 flex items-center justify-between gap-4 text-muted">
          <span>Net</span>
          <span
            className="money"
            style={{ color: point.net >= 0 ? POS : NEG }}
          >
            {point.net >= 0 ? "+" : "−"}
            {absMoney0(point.net)}
          </span>
        </div>
      )}
      <div className="mt-1 text-[11px] text-muted">Click to view transactions</div>
    </div>
  );
}

export default function MonthlyChart({
  points,
  colorMode,
  average,
  valueLabel,
}: {
  points: ChartPoint[];
  colorMode: "net" | "accent";
  average: number;
  valueLabel: string;
}) {
  const router = useRouter();

  function goToMonth(point: ChartPoint) {
    const { start, end } = monthBounds(point.month);
    router.push(`/transactions?start=${start}&end=${end}`);
  }

  return (
    <div className="h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={points}
          margin={{ top: 16, right: 12, bottom: 28, left: 4 }}
          barCategoryGap="28%"
        >
          <YAxis
            width={56}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            tickFormatter={(v: number) => money0(v)}
          />
          <XAxis
            dataKey="month"
            axisLine={{ stroke: "var(--color-line)" }}
            tickLine={false}
            interval={0}
            height={48}
            tick={<MonthTick points={points} colorMode={colorMode} />}
          />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            content={<ChartTooltip valueLabel={valueLabel} />}
          />
          {average > 0 && (
            <ReferenceLine
              y={average}
              stroke="var(--color-accent)"
              strokeDasharray="4 5"
              strokeOpacity={0.5}
              label={{
                value: `avg ${money0(average)}/mo`,
                position: "insideTopRight",
                fill: "var(--color-accent)",
                fontSize: 11,
                opacity: 0.85,
              }}
            />
          )}
          <Bar
            dataKey="value"
            radius={[6, 6, 0, 0]}
            cursor="pointer"
            onClick={(_data: unknown, index: number) => goToMonth(points[index])}
            isAnimationActive={false}
          >
            {points.map((point) => (
              <Cell key={point.month} fill={barFill(point, colorMode)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
