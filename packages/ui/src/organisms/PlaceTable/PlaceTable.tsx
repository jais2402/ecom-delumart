import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../molecules/EmptyState";

export type PlaceRow = {
  key: string;
  label: string;
  visitors: number;
  signUps: number;
  purchases: number;
  /** A row you can open to see the places inside it. */
  drillable?: boolean;
};

export type PlaceTableProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  caption: string;
  /** Heading of the first column: Country, Region or City. */
  placeHeader: string;
  rows: readonly PlaceRow[];
  onDrill?: (row: PlaceRow) => void;
  /** Accessible name of the drill button; defaults to "Show places in {label}". */
  drillLabel?: (row: PlaceRow) => string;
};

/** Share of the table's visitors, in tenths of a percent (integers only). */
function tenths(part: number, total: number): number {
  return total > 0 ? Math.round((part * 1000) / total) : 0;
}

const fmt = (n: number) => n.toLocaleString("en-IN");

/** Places with a proportional bar per row. A drillable row opens through a real button. */
export function PlaceTable({
  caption,
  placeHeader,
  rows,
  onDrill,
  drillLabel = (row) => `Show places in ${row.label}`,
  className,
  ...props
}: PlaceTableProps) {
  if (rows.length === 0) {
    return (
      <section aria-label={caption} className={className} {...props}>
        <EmptyState title="No data for this period yet" headingLevel={3} />
      </section>
    );
  }
  const total = rows.reduce((n, r) => n + r.visitors, 0);
  const th = "px-3 py-2 font-bold";
  return (
    <section
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard reachable
      tabIndex={0}
      aria-label={caption}
      className={cn(
        "relative max-w-full overflow-x-auto rounded-lg border border-border bg-surface",
        className,
      )}
      {...props}
    >
      <table className="w-full min-w-[34rem] border-collapse font-body text-sm text-fg">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border-strong bg-surface-raised">
            <th scope="col" className={cn(th, "text-left")}>
              {placeHeader}
            </th>
            <th scope="col" className={cn(th, "text-right")}>
              Daily visitors (summed)
            </th>
            <th scope="col" className={cn(th, "text-right")}>
              Sign-ups
            </th>
            <th scope="col" className={cn(th, "text-right")}>
              Purchases
            </th>
            <th scope="col" className={cn(th, "text-left")}>
              Share of visitors
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const share = tenths(row.visitors, total);
            return (
              <tr key={row.key} className="border-b border-border last:border-b-0">
                <th scope="row" className="px-3 py-1 text-left font-normal">
                  {row.drillable && onDrill ? (
                    <button
                      type="button"
                      aria-label={drillLabel(row)}
                      onClick={() => onDrill(row)}
                      className="inline-flex min-h-touch items-center text-left font-medium text-action underline underline-offset-2"
                    >
                      {row.label}
                    </button>
                  ) : (
                    row.label
                  )}
                </th>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(row.visitors)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(row.signUps)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(row.purchases)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div aria-hidden="true" className="h-2 w-24 shrink-0 rounded-pill bg-surface-raised">
                      <div
                        data-testid="place-bar"
                        className="h-2 rounded-pill bg-action"
                        style={{ width: `${share / 10}%` }}
                      />
                    </div>
                    <span className="tabular-nums">{`${share / 10}%`}</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
