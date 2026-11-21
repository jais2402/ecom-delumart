import { formatInrCompact, formatInrExact } from "@delulu/core";
import { type ComponentPropsWithRef, useId } from "react";
import { cn } from "../../lib/cn";

export type EarningsChartRow = {
  /** ISO date (YYYY-MM-DD), shown in the table. */
  date: string;
  /** Short label for the axis, e.g. "21 Nov". */
  label: string;
  orders: number;
  grossPaise: bigint;
  netPaise: bigint;
};

export type EarningsChartProps = Omit<ComponentPropsWithRef<"figure">, "children"> & {
  rows: readonly EarningsChartRow[];
  /** Names the chart and its table. */
  caption: string;
};

const W = 640;
const H = 220;
const PAD = { left: 8, right: 8, top: 12, bottom: 28 };

/** Share of `max` as a 0..1 number. Only drawing uses it; amounts stay bigint. */
function share(value: bigint, max: bigint): number {
  if (max <= 0n || value <= 0n) return 0;
  return Number((value * 10_000n) / max) / 10_000;
}

/**
 * Daily gross (hatched bars) and net (dashed line with diamond markers). The two series differ by
 * shape and pattern, never by colour alone. A text summary and a data table carry the same numbers.
 */
export function EarningsChart({ rows, caption, className, ...props }: EarningsChartProps) {
  const uid = useId().replace(/:/g, "");
  const patternId = `${uid}-hatch`;
  let max = 0n;
  for (const r of rows) if (r.grossPaise > max) max = r.grossPaise;
  const orders = rows.reduce((n, r) => n + r.orders, 0);
  const gross = rows.reduce((n, r) => n + r.grossPaise, 0n);
  const net = rows.reduce((n, r) => n + r.netPaise, 0n);
  const best = rows.reduce<EarningsChartRow | null>(
    (b, r) => (r.grossPaise > 0n && (b === null || r.grossPaise > b.grossPaise) ? r : b),
    null,
  );
  const summary =
    orders === 0
      ? `No sales in these ${rows.length} days.`
      : `Over ${rows.length} days: ${orders} ${orders === 1 ? "order" : "orders"}, gross ${formatInrExact(gross)}, net ${formatInrExact(net)}. Best day ${best?.label ?? ""} with gross ${formatInrExact(best?.grossPaise ?? 0n)}.`;

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const step = rows.length > 0 ? innerW / rows.length : innerW;
  const barW = Math.max(step * 0.7, 2);
  const x = (i: number) => PAD.left + step * i + step / 2;
  const y = (value: bigint) => PAD.top + innerH * (1 - share(value, max));
  const markers = rows.length <= 31;
  const labelEvery = Math.max(1, Math.ceil(rows.length / 7));
  const line = rows
    .map((r, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(r.netPaise).toFixed(1)}`)
    .join(" ");

  return (
    <figure className={cn("flex min-w-0 flex-col gap-3 font-body text-fg", className)} {...props}>
      <figcaption className="font-bold">{caption}</figcaption>
      <p data-testid="chart-summary">{summary}</p>
      <ul aria-label="Chart key" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <li className="flex items-center gap-2">
          <svg aria-hidden="true" width="24" height="14" className="text-action">
            <rect
              width="24"
              height="14"
              fill={`url(#${patternId})`}
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
          Gross sales (hatched bars)
        </li>
        <li className="flex items-center gap-2">
          <svg aria-hidden="true" width="24" height="14" className="text-fg">
            <path d="M0 7H24" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3" />
            <path d="M12 2L17 7L12 12L7 7Z" fill="currentColor" />
          </svg>
          Net earnings (dashed line, diamonds)
        </li>
      </ul>
      {rows.length > 0 ? (
        <svg
          role="img"
          aria-label={`${caption}. The table below has the same numbers.`}
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full max-w-full"
        >
          <defs>
            <pattern
              id={patternId}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="6" height="6" className="fill-surface" />
              <path d="M0 0V6" stroke="currentColor" strokeWidth="2.5" />
            </pattern>
          </defs>
          <g className="text-fg-muted">
            <path
              d={`M${PAD.left} ${PAD.top + innerH}H${W - PAD.right}`}
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
            <text x={PAD.left} y={PAD.top - 2} fontSize="11" fill="currentColor">
              {formatInrCompact(max)}
            </text>
          </g>
          <g className="text-action">
            {rows.map((r, i) => (
              <rect
                key={r.date}
                data-series="gross"
                x={x(i) - barW / 2}
                y={y(r.grossPaise)}
                width={barW}
                height={Math.max(PAD.top + innerH - y(r.grossPaise), 0)}
                fill={`url(#${patternId})`}
                stroke="currentColor"
                strokeWidth="1.5"
              />
            ))}
          </g>
          <g className="text-fg">
            <path
              data-series="net"
              d={line}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeDasharray="6 4"
            />
            {markers
              ? rows.map((r, i) => {
                  const cx = x(i);
                  const cy = y(r.netPaise);
                  return (
                    <path
                      key={r.date}
                      data-series="net-marker"
                      d={`M${cx} ${cy - 5}L${cx + 5} ${cy}L${cx} ${cy + 5}L${cx - 5} ${cy}Z`}
                      fill="currentColor"
                    />
                  );
                })
              : null}
          </g>
          <g className="text-fg-muted">
            {rows.map((r, i) =>
              i % labelEvery === 0 ? (
                <text key={r.date} x={x(i)} y={H - 8} fontSize="11" textAnchor="middle" fill="currentColor">
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
        className="max-w-full overflow-x-auto rounded-lg border border-border bg-surface"
      >
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{`${caption}: one row per day`}</caption>
          <thead>
            <tr className="border-b border-border-strong bg-surface-raised">
              <th scope="col" className="px-3 py-2 text-left font-bold">
                Date
              </th>
              <th scope="col" className="px-3 py-2 text-right font-bold">
                Orders
              </th>
              <th scope="col" className="px-3 py-2 text-right font-bold">
                Gross
              </th>
              <th scope="col" className="px-3 py-2 text-right font-bold">
                Net
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.date} className="border-b border-border last:border-b-0">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {r.date}
                </th>
                <td className="px-3 py-2 text-right tabular-nums">{r.orders}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatInrExact(r.grossPaise)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatInrExact(r.netPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </figure>
  );
}
