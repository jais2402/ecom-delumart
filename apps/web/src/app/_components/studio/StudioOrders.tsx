"use client";

import { Alert, Badge, Button, DataTable, Price, SourceBadge } from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "../../_lib/api";
import { ANONYMOUS_BUYER, type MerchantOrder, type MerchantOrdersPage } from "../../_lib/merchant";
import { parsePaise } from "../../_lib/money";
import { deliveryStatus, formatWhen } from "../../_lib/orders";
import { SPEED_COPY } from "../../_lib/speeds";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PortalTitle } from "./PortalTitle";

const PAGE_SIZE = 10;

/** Delivery speed and status in words: "Standard · Delivered". */
export function OrderDelivery({ order }: { order: MerchantOrder }) {
  if (order.status === "REVERSED") return <Badge tone="danger">Reversed</Badge>;
  const s = deliveryStatus(order.delivery, Date.now());
  return (
    <span className="flex flex-col gap-1">
      <span>{order.delivery ? SPEED_COPY[order.delivery.speed].name : "No delivery"}</span>
      <Badge tone={s.tone}>{s.label}</Badge>
    </span>
  );
}

/** /studio/orders: the shop's orders, newest first, ten to a page. Buyers are never named. */
export function StudioOrders() {
  // cursors[i] is the cursor that loads page i (null for the first)
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [index, setIndex] = useState(0);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; page: MerchantOrdersPage }
  >({ status: "loading" });
  const [tick, setTick] = useState(0);
  const cursor = cursors[index] ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick retries the load
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    api<MerchantOrdersPage>(`/api/v1/studio/orders?limit=${PAGE_SIZE}${cursor ? `&cursor=${cursor}` : ""}`, {
      signal: controller.signal,
    })
      .then((page) => setState({ status: "ready", page }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", message: describeError(error) });
      });
    return () => controller.abort();
  }, [cursor, tick]);
  const retry = useCallback(() => setTick((n) => n + 1), []);

  function older(next: string) {
    setCursors((c) => [...c.slice(0, index + 1), next]);
    setIndex(index + 1);
  }

  return (
    <div className="flex flex-col gap-4">
      <PortalTitle>Orders</PortalTitle>
      {state.status === "loading" ? <LoadingBlock rows={4} label="Loading your orders" /> : null}
      {state.status === "error" ? <ErrorBlock message={state.message} onRetry={retry} /> : null}
      {state.status === "ready" ? (
        <>
          <Alert tone="info">
            Buyers are anonymous. You see what was bought and what it earned, never who bought.
          </Alert>
          <DataTable
            caption="Your orders"
            emptyTitle="No orders yet"
            emptyDescription="When a player buys from your shop, the order appears here."
            rows={state.page.items}
            rowKey={(o) => o.id}
            columns={[
              {
                key: "time",
                header: "Time",
                cell: (o) => (
                  <a
                    href={`/studio/orders/${o.id}`}
                    className="inline-flex min-h-touch items-center text-action underline"
                  >
                    {formatWhen(o.orderedAt)}
                  </a>
                ),
              },
              { key: "buyer", header: "Buyer", cell: () => ANONYMOUS_BUYER },
              { key: "items", header: "Items", cell: (o) => o.lines.map((l) => l.name).join(", ") },
              {
                key: "gross",
                header: "Gross",
                align: "right",
                cell: (o) => <Price amountPaise={parsePaise(o.grossPaise)} display="exact" />,
              },
              {
                key: "fee",
                header: "Fee",
                align: "right",
                cell: (o) => <Price amountPaise={parsePaise(o.feePaise)} display="exact" />,
              },
              {
                key: "net",
                header: "Net",
                align: "right",
                cell: (o) => <Price amountPaise={parsePaise(o.netPaise)} display="exact" />,
              },
              { key: "delivery", header: "Delivery", cell: (o) => <OrderDelivery order={o} /> },
              {
                key: "source",
                header: "Source",
                cell: (o) => (
                  <span className="flex flex-col gap-1">
                    <SourceBadge source={o.source === "STAFF" ? "staff" : "player"} />
                  </span>
                ),
              },
            ]}
          />
          <nav aria-label="Order pages" className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="secondary" disabled={index === 0} onClick={() => setIndex(index - 1)}>
              Newer orders
            </Button>
            <span className="text-sm text-fg" aria-live="polite">
              Page {index + 1}
            </span>
            <Button
              variant="secondary"
              disabled={state.page.nextCursor === null}
              onClick={() => state.page.nextCursor && older(state.page.nextCursor)}
            >
              Older orders
            </Button>
          </nav>
        </>
      ) : null}
    </div>
  );
}
