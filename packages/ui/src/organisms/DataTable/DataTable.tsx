import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../molecules/EmptyState";

export type DataColumn<Row> = {
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  align?: "left" | "right";
};

export type DataTableProps<Row> = Omit<ComponentPropsWithRef<"section">, "children"> & {
  caption: string;
  columns: readonly DataColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  emptyTitle?: string;
  emptyDescription?: string;
};

/** Scrolls sideways inside its own focusable region; the page never does. */
export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  emptyTitle = "No rows to show",
  emptyDescription,
  className,
  ...props
}: DataTableProps<Row>) {
  if (rows.length === 0) {
    return (
      <section aria-label={caption} className={className} {...props}>
        <EmptyState title={emptyTitle} {...(emptyDescription ? { description: emptyDescription } : {})} />
      </section>
    );
  }
  return (
    <section
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard reachable
      tabIndex={0}
      aria-label={caption}
      className={cn("max-w-full overflow-x-auto rounded-lg border border-border bg-surface", className)}
      {...props}
    >
      <table className="w-full border-collapse font-body text-sm text-fg">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border-strong bg-surface-raised">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn("px-3 py-2 font-bold", column.align === "right" ? "text-right" : "text-left")}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-border last:border-b-0">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn("px-3 py-2 align-top", column.align === "right" && "text-right")}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
