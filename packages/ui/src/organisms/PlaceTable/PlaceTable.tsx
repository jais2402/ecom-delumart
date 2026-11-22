import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../molecules/EmptyState";

export type PlaceRow = {
  key: string;
  label: string;
  /** Null for a suppressed row (below the minimum count): shown as "Fewer than {minVisitors}". */
  visitors: number | null;
  signUps: number | null;
  purchases: number | null;
  /** Too few visitors to show any count (PRD R7.1). */
  suppressed?: boolean;
  /** A row you can open to see the places inside it. */
  drillable?: boolean;
};

export type PlaceTableProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  caption: string;
  /** Heading of the first column: Country, Region or City. */
  placeHeader: string;
  rows: readonly PlaceRow[];
  /** The minimum count below which a row is suppressed ("Fewer than {minVisitors}"). */
  minVisitors?: number;
  /**
   * The minimum below which a shown row's sign-up or purchase count is withheld (the API sends
   * null): such a cell reads "Fewer than {minCellCount}".
   */
  minCellCount?: number;
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
  minVisitors,
  minCellCount,
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
  const shown = (r: PlaceRow): r is PlaceRow & { visitors: number } => !r.suppressed && r.visitors !== null;
  const total = rows.reduce((n, r) => n + (shown(r) ? r.visitors : 0), 0);
  const hidden = <span className="text-fg-muted">Not shown</span>;
  const fewer = <span className="text-fg-muted">{`Fewer than ${fmt(minCellCount ?? 0)}`}</span>;
  const count = (n: number | null) => (n === null ? (minCellCount === undefined ? hidden : fewer) : fmt(n));
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
            const share = shown(row) ? tenths(row.visitors, total) : null;
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
                {shown(row) ? (
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(row.visitors)}</td>
                ) : (
                  <td className="px-3 py-2 text-right text-fg-muted">
                    {minVisitors === undefined ? "Too few to show" : `Fewer than ${fmt(minVisitors)}`}
                  </td>
                )}
                <td className="px-3 py-2 text-right tabular-nums">
                  {shown(row) ? count(row.signUps) : hidden}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {shown(row) ? count(row.purchases) : hidden}
                </td>
                <td className="px-3 py-2">
                  {share === null ? (
                    <span className="text-fg-muted">Not shown</span>
                  ) : (
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
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
