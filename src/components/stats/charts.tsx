// Reusable recharts wrappers for the /stats dashboard, themed to the (monochrome)
// brand with green/red reserved for directional / signed values.
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  PieChart,
  Pie,
  AreaChart,
  Area,
  ComposedChart,
  Line,
  LabelList,
} from "recharts";

export const GRAY = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];
export const POS = "oklch(0.72 0.18 158)"; // long / positive
export const NEG = "oklch(0.62 0.21 25)"; // short / negative

const TIP_STYLE = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 0,
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 11,
  padding: "6px 10px",
} as const;
const AXIS = { fontFamily: "monospace", fontSize: 10, fill: "var(--muted-foreground)" } as const;

export function Panel({
  title,
  hint,
  children,
  className = "",
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`border border-border bg-card p-5 ${className}`}>
      <div className="mb-4 flex items-baseline justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{title}</div>
        {hint ? <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/60">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function StatCard({ label, value, accent }: { label: string; value: string; accent?: "pos" | "neg" }) {
  const color = accent === "pos" ? POS : accent === "neg" ? NEG : "var(--foreground)";
  return (
    <div className="border border-border bg-card p-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className="mt-1.5 font-mono text-xl tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

// Horizontal ranked bars (e.g. most-used assets).
export function HBars({ data, height = 300 }: { data: { label: string; value: number }[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="2 4" />
        <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="label" tick={AXIS} width={64} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={TIP_STYLE} cursor={{ fill: "var(--accent)" }} />
        <Bar dataKey="value" radius={[0, 2, 2, 0]}>
          {data.map((_, i) => (
            <Cell key={i} fill={GRAY[i % GRAY.length]} />
          ))}
          <LabelList dataKey="value" position="right" className="fill-muted-foreground" style={{ fontSize: 10, fontFamily: "monospace" }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// Vertical bars colored by an arbitrary key->color map (e.g. leverage base/degen).
export function VBars({
  data,
  colorFor,
  height = 260,
}: {
  data: { label: string; value: number; tier?: string }[];
  colorFor: (d: { label: string; value: number; tier?: string }) => string;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ left: -16, right: 8, top: 8, bottom: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
        <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={TIP_STYLE} cursor={{ fill: "var(--accent)" }} />
        <Bar dataKey="value" radius={[2, 2, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={colorFor(d)} />
          ))}
          <LabelList dataKey="value" position="top" className="fill-muted-foreground" style={{ fontSize: 10, fontFamily: "monospace" }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// Donut with a side legend.
export function Donut({
  data,
  colors,
  height = 200,
}: {
  data: { label: string; value: number }[];
  colors?: string[];
  height?: number;
}) {
  const palette = colors ?? GRAY;
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  return (
    <div className="flex items-center gap-4">
      <ResponsiveContainer width="55%" height={height}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="label" innerRadius="58%" outerRadius="92%" paddingAngle={1} stroke="var(--card)">
            {data.map((_, i) => (
              <Cell key={i} fill={palette[i % palette.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={TIP_STYLE} />
        </PieChart>
      </ResponsiveContainer>
      <div className="flex-1 space-y-1.5">
        {data.map((d, i) => (
          <div key={d.label} className="flex items-center gap-2 font-mono text-[11px]">
            <span className="h-2 w-2 shrink-0" style={{ background: palette[i % palette.length] }} />
            <span className="capitalize text-muted-foreground">{d.label}</span>
            <span className="ml-auto tabular-nums">{d.value}</span>
            <span className="w-9 text-right tabular-nums text-muted-foreground/60">
              {((d.value / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Area trend (e.g. fees/day).
export function AreaTrend({
  data,
  xKey,
  yKey,
  color = "var(--chart-1)",
  height = 220,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string;
  color?: string;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ left: -12, right: 8, top: 8, bottom: 4 }}>
        <defs>
          <linearGradient id={`g-${yKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
        <XAxis dataKey={xKey} tick={AXIS} axisLine={false} tickLine={false} minTickGap={24} />
        <YAxis tick={AXIS} axisLine={false} tickLine={false} width={40} />
        <Tooltip contentStyle={TIP_STYLE} />
        <Area type="monotone" dataKey={yKey} stroke={color} strokeWidth={1.5} fill={`url(#g-${yKey})`} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// Bars + overlaid line on a second axis (e.g. launches/day + cumulative buyback).
export function ComboBarsLine({
  data,
  xKey,
  barKey,
  lineKey,
  barLabel,
  lineLabel,
  height = 260,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  barKey: string;
  lineKey: string;
  barLabel: string;
  lineLabel: string;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ left: -14, right: 6, top: 8, bottom: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
        <XAxis dataKey={xKey} tick={AXIS} axisLine={false} tickLine={false} minTickGap={24} />
        <YAxis yAxisId="l" tick={AXIS} axisLine={false} tickLine={false} width={32} />
        <YAxis yAxisId="r" orientation="right" tick={AXIS} axisLine={false} tickLine={false} width={40} />
        <Tooltip contentStyle={TIP_STYLE} cursor={{ fill: "var(--accent)" }} />
        <Bar yAxisId="l" dataKey={barKey} name={barLabel} fill="var(--chart-3)" radius={[2, 2, 0, 0]} />
        <Line yAxisId="r" type="monotone" dataKey={lineKey} name={lineLabel} stroke={POS} strokeWidth={1.75} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
