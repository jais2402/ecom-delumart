"use client";

import { Alert, Badge, Button, EmptyState, Heading, Receipt, Text, TrackingTimeline } from "@delulu/ui";
import { useEffect, useState } from "react";
import type { OrderResponse } from "../_lib/api";
import { parsePaise } from "../_lib/money";
import { formatWhen, orderTotals, statusLabel, trackingStages } from "../_lib/orders";
import { errorCode, useApiGet } from "../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "./LoadState";
import { PageHeading } from "./PageHeading";

/** One order: receipt, then tracking computed from the shipment times. `justPaid` adds the success note. */
export function OrderDetail({ id, justPaid = false }: { id: string; justPaid?: boolean }) {
  const result = useApiGet<OrderResponse>(`/api/v1/orders/${id}`);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  if (result.status === "loading") {
    return (
      <>
        <PageHeading>Your order</PageHeading>
        <div className="mt-4">
          <LoadingBlock rows={4} label="Loading your order" />
        </div>
      </>
    );
  }
  if (result.status === "error") {
    return errorCode(result.error) === "NOT_FOUND" ? (
      <>
        <PageHeading>Order not found</PageHeading>
        <EmptyState
          className="mt-4"
          title="We could not find that order"
          description="It may belong to another account."
          action={
            <Button asChild>
              <a href="/account/orders">Your orders</a>
            </Button>
          }
        />
      </>
    ) : (
      <>
        <PageHeading>Your order</PageHeading>
        <div className="mt-4">
          <ErrorBlock message={result.message} onRetry={result.reload} />
        </div>
      </>
    );
  }

  const order = result.data;
  const totals = orderTotals(order);
  const lines = order.sellerOrders.flatMap((so) =>
    so.lines.map((line) => ({
      id: line.id,
      name: line.name,
      quantity: 1,
      totalPaise:
        parsePaise(line.listPaise) -
        parsePaise(line.sellerDiscountPaise) -
        parsePaise(line.platformDiscountPaise),
    })),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <PageHeading>{justPaid ? "Order placed" : "Your order"}</PageHeading>
        {justPaid ? (
          <Alert tone="success" title="Payment complete">
            Thanks. Your fictional money has moved and your order is on its way.
          </Alert>
        ) : null}
      </div>
      <div className="grid items-start gap-6 md:grid-cols-2">
        <Receipt
          reference={order.paymentReference}
          placedAt={formatWhen(order.createdAt)}
          lines={lines}
          itemsTotalPaise={totals.items}
          discountPaise={totals.discount}
          deliveryFeePaise={totals.delivery}
          totalPaise={totals.total}
        />
        <div className="flex flex-col gap-6">
          {order.sellerOrders.map((so) => (
            <section
              key={so.id}
              aria-label={`Tracking for ${so.sellerName ?? "DeluluMart Originals"}`}
              className="flex flex-col gap-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Heading level={2} size="sm">
                  Tracking
                </Heading>
                <Badge tone={so.status === "DELIVERED" ? "success" : "info"}>{statusLabel(so.status)}</Badge>
              </div>
              <Text size="sm" muted>
                Sold by {so.sellerName ?? "DeluluMart Originals"}
              </Text>
              {so.shipment ? (
                <TrackingTimeline stages={trackingStages(so.shipment, now)} />
              ) : (
                <Text muted>Shipping details will appear here.</Text>
              )}
            </section>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="secondary">
          <a href="/account/orders">All orders</a>
        </Button>
        <Button asChild>
          <a href="/">Keep shopping</a>
        </Button>
      </div>
    </div>
  );
}
