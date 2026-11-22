"use client";

import {
  AddressCard,
  Alert,
  Badge,
  Button,
  EmptyState,
  Heading,
  Receipt,
  Text,
  TrackingTimeline,
} from "@delulu/ui";
import { useEffect, useState } from "react";
import type { OrderResponse } from "../_lib/api";
import { parsePaise } from "../_lib/money";
import { deliveryStatus, formatWhen, orderTotals, trackingStages } from "../_lib/orders";
import { errorCode, useApiGet } from "../_lib/use-api";
import { useProducts } from "../_lib/use-products";
import { ErrorBlock, LoadingBlock } from "./LoadState";
import { PageHeading } from "./PageHeading";

/** One order: receipt, then tracking computed from the shipment times. `justPaid` adds the success note. */
export function OrderDetail({ id, justPaid = false }: { id: string; justPaid?: boolean }) {
  const result = useApiGet<OrderResponse>(`/api/v1/orders/${id}`);
  // an exclusive's serial reads "#1 of 3": the edition's supply comes from the public product
  const serialIds =
    result.status === "ready"
      ? result.data.sellerOrders.flatMap((so) =>
          so.lines.filter((l) => l.editionSerial !== null).map((l) => l.productId),
        )
      : [];
  const { products } = useProducts(serialIds);
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
  const serialText = (line: { productId: string; editionSerial: number | null }): string | null => {
    if (line.editionSerial === null) return null;
    const supply = products.get(line.productId)?.edition?.supply;
    return supply ? `#${line.editionSerial} of ${supply}` : `#${line.editionSerial}`;
  };
  const lines = order.sellerOrders.flatMap((so) =>
    so.lines.map((line) => ({
      id: line.id,
      name: serialText(line) ? `${line.name} (${serialText(line)})` : line.name,
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
          paymentStatus="Paid"
          itemsTotalPaise={totals.items}
          discountPaise={totals.discount}
          deliveryFeePaise={totals.delivery}
          totalPaise={totals.total}
        />
        <div className="flex flex-col gap-6">
          <section aria-labelledby="delivery-to" className="flex flex-col gap-2">
            <Heading level={2} size="sm" id="delivery-to">
              Delivery address
            </Heading>
            {order.delivery?.kind === "ADDRESS" ? (
              <AddressCard label={order.delivery.labelName} text={order.delivery.text} kind="real" />
            ) : order.delivery?.kind === "ADDRESS_REMOVED" ? (
              <Text muted>Address removed</Text>
            ) : (
              <AddressCard
                label="Fictional delivery spot"
                text={order.delivery?.kind === "FICTIONAL_SPOT" ? order.delivery.text : "A fictional spot"}
                kind="fictional"
              />
            )}
            <Text size="sm" muted>
              Nothing real ships — delivery is simulated. Only you can see this address.
            </Text>
          </section>
          {order.sellerOrders.map((so) => {
            const delivery = deliveryStatus(so.shipment, now);
            const seller = so.sellerName ?? "DeluluMart Originals";
            return (
              <section
                key={so.id}
                aria-label={`Delivery from ${seller}`}
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
              >
                <Heading level={2} size="sm" className="break-words">
                  Sold by {seller}
                </Heading>
                <ul className="list-disc pl-5 text-base text-fg">
                  {so.lines.map((line) => (
                    <li key={line.id} className="break-words">
                      {line.name}
                      {serialText(line) ? ` — edition ${serialText(line)}` : ""}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-2">
                  <Heading level={3} size="sm">
                    Tracking
                  </Heading>
                  <Badge tone={delivery.tone}>{delivery.label}</Badge>
                  {delivery.detail ? (
                    <Text as="span" size="sm" muted>
                      {delivery.detail}
                    </Text>
                  ) : null}
                </div>
                {so.shipment ? (
                  <TrackingTimeline stages={trackingStages(so.shipment, now)} />
                ) : (
                  <Text muted>Shipping details will appear here.</Text>
                )}
              </section>
            );
          })}
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
