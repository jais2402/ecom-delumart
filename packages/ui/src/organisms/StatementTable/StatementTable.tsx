import type { ComponentPropsWithRef } from "react";
import { Price } from "../../atoms/Price";
import { VisuallyHidden } from "../../atoms/VisuallyHidden";
import { cn } from "../../lib/cn";
import { type DataColumn, DataTable } from "../DataTable";

export type StatementRow = {
  id: string;
  date: string;
  dateTime?: string;
  description: string;
  /** Signed paise: positive credits, negative debits. */
  amountPaise: bigint;
  balanceAfterPaise: bigint;
};

export type StatementTableProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  rows: readonly StatementRow[];
  caption?: string;
};

const columns: readonly DataColumn<StatementRow>[] = [
  {
    key: "date",
    header: "Date",
    cell: (row) => (
      <time dateTime={row.dateTime} className="whitespace-nowrap">
        {row.date}
      </time>
    ),
  },
  { key: "description", header: "Description", cell: (row) => row.description },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    cell: (row) => {
      const credit = row.amountPaise >= 0n;
      const magnitude = credit ? row.amountPaise : -row.amountPaise;
      return (
        <span className={cn("whitespace-nowrap font-semibold", credit && "text-success")}>
          <VisuallyHidden>{credit ? "Credit " : "Debit "}</VisuallyHidden>
          <span aria-hidden="true">{credit ? "+" : "−"}</span>
          <Price amountPaise={magnitude} display="exact" className={cn(credit && "text-success")} />
        </span>
      );
    },
  },
  {
    key: "balance",
    header: "Balance after",
    align: "right",
    cell: (row) => (
      <Price amountPaise={row.balanceAfterPaise} display="exact" className="whitespace-nowrap" />
    ),
  },
];

export function StatementTable({ rows, caption = "Account statement", ...props }: StatementTableProps) {
  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      emptyTitle="No transactions yet"
      emptyDescription="Spending and refunds will appear here."
      {...props}
    />
  );
}
