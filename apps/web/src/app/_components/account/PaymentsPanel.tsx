"use client";

import { Badge, type DataColumn, DataTable, Heading, Pagination, Price, Text } from "@delulu/ui";
import { useEffect, useState } from "react";
import { api, describeError } from "../../_lib/api";
import { parsePaise } from "../../_lib/money";
import { formatWhen } from "../../_lib/orders";
import { methodLabel, type PaymentRowResponse, statusTone } from "../../_lib/payments";
import { PAYMENT_UI_CONFIG } from "../../_lib/payments-config";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";

interface Page {
  items: PaymentRowResponse[];
  nextCursor: string | null;
}

const PAGE_SIZE = PAYMENT_UI_CONFIG.paymentsPageSize;

const STATUS_NAME: Record<PaymentRowResponse["status"], string> = {
  CREATED: "Created",
  AUTHENTICATING: "Authenticating",
  AUTHORISED: "Authorised",
  CAPTURED: "Captured",
  FAILED: "Failed",
  REFUNDED: "Refunded",
};

/**
 * Account -> Payments (PRD R3): every payment attempt with its method, status, reference and, for a
 * failed one, the reason (which says that no fictional money moved). Private to the owner. A failed
 * attempt never appears in the wallet statement.
 */
export function PaymentsPanel() {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick retries the same page
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPage(null);
    const cursor = cursors[pageIndex];
    api<Page>(
      `/api/v1/account/payments?limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    )
      .then((data) => {
        if (cancelled) return;
        setPage(data);
        setCursors((known) =>
          data.nextCursor && known.length === pageIndex + 1 ? [...known, data.nextCursor] : known,
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [pageIndex, cursors, tick]);

  const columns: DataColumn<PaymentRowResponse>[] = [
    { key: "when", header: "Date", cell: (p) => formatWhen(p.createdAt) },
    { key: "method", header: "Method", cell: (p) => methodLabel(p.method) },
    {
      key: "ref",
      header: "Reference",
      cell: (p) => <span className="font-mono text-xs">{p.reference}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (p) => (
        <div className="flex flex-col gap-1">
          <Badge tone={statusTone(p.status)}>{STATUS_NAME[p.status]}</Badge>
          {p.status === "FAILED" && p.failureTitle ? (
            <>
              <span className="font-medium text-fg">{p.failureTitle}</span>
              <span className="text-fg-muted">{p.failureMessage}</span>
            </>
          ) : null}
        </div>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      cell: (p) => <Price amountPaise={parsePaise(p.amountPaise)} display="exact" />,
    },
  ];
  const pageCount = Math.max(pageIndex + 1, cursors.length);

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Payments</PageHeading>
      <Text muted>
        Every payment attempt, newest first. A failed payment shows why, and that no fictional money moved.
        Refunds appear here when staff reverse an order.
      </Text>
      <Text size="sm" muted>
        In-game payment · fictional money
      </Text>
      <section aria-labelledby="payments-list" className="flex flex-col gap-3">
        <Heading level={2} size="md" id="payments-list">
          Payment history
        </Heading>
        {error ? <ErrorBlock message={error} onRetry={() => setTick((n) => n + 1)} /> : null}
        {!error && page === null ? <LoadingBlock rows={4} label="Loading your payments" /> : null}
        {page !== null ? (
          <DataTable
            caption="Payments, newest first"
            columns={columns}
            rows={page.items}
            rowKey={(p) => p.id}
            emptyTitle="No payments yet"
            emptyDescription="When you pay for something, the attempt shows up here."
          />
        ) : null}
        {page !== null && (pageIndex > 0 || page.nextCursor) ? (
          <Pagination page={pageIndex + 1} pageCount={pageCount} onPageChange={(p) => setPageIndex(p - 1)} />
        ) : null}
      </section>
    </div>
  );
}
