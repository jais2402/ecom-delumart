import { type ComponentPropsWithRef, useId } from "react";
import { cn } from "../../lib/cn";

export type LineChartRow = {
  /** ISO date (YYYY-MM-DD), shown in the table. */
  date: string;
  /** Short label for the axis, e.g. "21 Nov". */
  label: string;
  /** null means there is no figure for the day. It is a gap, never zero. */
  value: bigint | null;
};

export type LineChartProps = Omit<ComponentPropsWithRef<"figure">, "children"> & {
  rows: readonly LineChartRow[];
  /** Names the chart and its table. */
  caption: string;
  /** Name of the measure, used in the key and the table header. */
  valueLabel: string;
  /** Formats one value for text, e.g. as a count or as exact money. */
  formatValue: (value: bigint) => string;
};

const W = 640;
const H = 240;
const PAD = { left: 8, right: 8, top: 18, bottom: 28 };

/** Share of `max` as a 0..1 number. Only drawing uses it; the values themselves stay bigint. */
function share(value: bigint, max: bigint): number {
  if (max <= 0n || value <= 0n) return 0;
  return Number((value * 10_000n) / max) / 10_000;
}

/**
 * One measure per day as a line over a soft area. Days without a figure leave a visible gap (the
 * line breaks and the baseline gets a tick), they are never drawn as zero. A text summary and a
 * data table carry the same numbers.
 */
export function LineChart({ rows, caption, valueLabel, formatValue, className, ...props }: LineChartProps) {
  const captionId = useId();
  let max = 0n;
  let total = 0n;
  let known = 0;
  let peak: LineChartRow | null = null;
  for (const r of rows) {
    if (r.value === null) continue;
    known += 1;
    total += r.value;
    if (r.value > max) max = r.value;
    if (r.value > 0n && (peak === null || r.value > (peak.value ?? 0n))) peak = r;
  }
  const gaps = rows.length - known;
  const summary =
    known === 0
      ? `No data in these ${rows.length} days.`
      : `${known} of ${rows.length} days have data. Total ${formatValue(total)}.${
          peak?.value ? ` Peak ${formatValue(peak.value)} on ${peak.date}.` : ""
        }${gaps > 0 ? ` ${gaps} ${gaps === 1 ? "day has" : "days have"} no figure yet and ${gaps === 1 ? "is" : "are"} left blank.` : ""}`;

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const base = PAD.top + innerH;
  const step = rows.length > 1 ? innerW / (rows.length - 1) : 0;
  const x = (i: number) => (rows.length > 1 ? PAD.left + step * i : PAD.left + innerW / 2);
  const y = (value: bigint) => PAD.top + innerH * (1 - share(value, max));
  const markers = rows.length <= 31;
  const labelEvery = Math.max(1, Math.ceil(rows.length / 7));

  // runs of consecutive days that have a figure; a null day ends a run
  const runs: { i: number; v: bigint }[][] = [];
  let run: { i: number; v: bigint }[] = [];
  rows.forEach((r, i) => {
    if (r.value === null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push({ i, v: r.value });
  });
  if (run.length) runs.push(run);
  const linePath = (pts: { i: number; v: bigint }[]) =>
    pts.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const areaPath = (pts: { i: number; v: bigint }[]) => {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last) return "";
    return `${linePath(pts)} L${x(last.i).toFixed(1)} ${base} L${x(first.i).toFixed(1)} ${base} Z`;
  };

  return (
    <figure
      aria-labelledby={captionId}
      className={cn("flex min-w-0 flex-col gap-3 font-body text-fg", className)}
      {...props}
    >
      <figcaption id={captionId} className="font-bold">
        {caption}
      </figcaption>
      <p data-testid="chart-summary">{summary}</p>
      <ul aria-label="Chart key" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <li className="flex items-center gap-2">
          <svg aria-hidden="true" width="24" height="14" className="text-action">
            <path d="M0 13V8L8 5L16 9L24 2V13Z" className="fill-action-soft" />
            <path d="M0 8L8 5L16 9L24 2" stroke="currentColor" strokeWidth="2" fill="none" />
          </svg>
          {`${valueLabel} (line over a shaded area)`}
        </li>
        {gaps > 0 ? (
          <li className="flex items-center gap-2">
            <svg aria-hidden="true" width="24" height="14" className="text-fg">
              <path d="M12 4V13" stroke="currentColor" strokeWidth="2" strokeDasharray="2 2" />
            </svg>
            Dashed tick on the baseline: no figure for that day (a gap, not zero)
          </li>
        ) : null}
      </ul>
      {rows.length > 0 ? (
        <svg
          role="img"
          aria-label={`${caption}. The table below has the same numbers.`}
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full max-w-full"
        >
          <g className="text-fg-muted">
            <path
              d={`M${PAD.left} ${base}H${W - PAD.right}`}
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
            <text x={PAD.left} y={PAD.top - 5} fontSize="11" fill="currentColor">
              {formatValue(max)}
            </text>
          </g>
          <g className="text-action">
            {runs.map((pts) => (
              <g key={pts[0]?.i}>
                {pts.length > 1 ? (
                  <>
                    <path data-series="area" d={areaPath(pts)} className="fill-action-soft" opacity="0.7" />
                    <path
                      data-series="line"
                      d={linePath(pts)}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    />
                  </>
                ) : null}
              </g>
            ))}
            {rows.map((r, i) => {
              if (r.value === null) return null;
              const before = rows[i - 1]?.value;
              const after = rows[i + 1]?.value;
              const isolated = before == null && after == null;
              if (!markers && !isolated) return null;
              return (
                <circle
                  key={r.date}
                  data-series="marker"
                  cx={x(i)}
                  cy={y(r.value)}
                  r={isolated ? 4 : 3}
                  fill="currentColor"
                />
              );
            })}
          </g>
          <g className="text-fg">
            {rows.map((r, i) =>
              r.value === null ? (
                <path
                  key={r.date}
                  data-series="gap"
                  d={`M${x(i)} ${base - 14}V${base}`}
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeDasharray="2 2"
                />
              ) : null,
            )}
          </g>
          <g className="text-fg-muted">
            {rows.map((r, i) =>
              i % labelEvery === 0 ? (
                <text
                  key={r.date}
                  x={x(i)}
                  y={H - 8}
                  fontSize="11"
                  textAnchor={i === 0 && rows.length > 1 ? "start" : "middle"}
                  fill="currentColor"
                >
                  {r.label}
                </text>
              ) : null,
            )}
          </g>
        </svg>
      ) : null}
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard reachable
        tabIndex={0}
        aria-label={`${caption}: data table`}
        className="max-h-72 max-w-full overflow-auto rounded-lg border border-border bg-surface"
      >
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{`${caption}: one row per day`}</caption>
          <thead>
            <tr className="border-b border-border-strong bg-surface-raised">
              <th scope="col" className="px-3 py-2 text-left font-bold">
                Date
              </th>
              <th scope="col" className="px-3 py-2 text-right font-bold">
                {valueLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.date} className="border-b border-border last:border-b-0">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {r.date}
                </th>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.value === null ? "Not available yet" : formatValue(r.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </figure>
  );
}
