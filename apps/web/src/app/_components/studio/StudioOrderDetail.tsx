"use client";

import {
  Alert,
  Badge,
  DataTable,
  Heading,
  OrderEquation,
  Price,
  SourceBadge,
  Text,
  TrackingTimeline,
} from "@delulu/ui";
import { ANONYMOUS_BUYER, type MerchantOrder } from "../../_lib/merchant";
import { parsePaise } from "../../_lib/money";
import { formatWhen, trackingStages } from "../../_lib/orders";
import { SPEED_COPY } from "../../_lib/speeds";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PortalTitle } from "./PortalTitle";

/** /studio/orders/[id]: one order of the shop, as the seller's money and the delivery. */
export function StudioOrderDetail({ orderId }: { orderId: string }) {
  const loaded = useApiGet<{ order: MerchantOrder }>(`/api/v1/studio/orders/${orderId}`);
  return (
    <div className="flex flex-col gap-6">
      <a
        href="/studio/orders"
        className="inline-flex min-h-touch items-center self-start text-action underline"
      >
        All orders
      </a>
      {loaded.status === "loading" ? <LoadingBlock rows={3} label="Loading the order" /> : null}
      {loaded.status === "error" ? <ErrorBlock message={loaded.message} onRetry={loaded.reload} /> : null}
      {loaded.status === "ready" ? <Detail order={loaded.data.order} /> : null}
    </div>
  );
}

function Detail({ order }: { order: MerchantOrder }) {
  const buyerFee = parsePaise(order.deliveryFeeBuyerPaise);
  return (
    <>
      <PortalTitle>Order of {formatWhen(order.orderedAt)}</PortalTitle>
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
        <dt className="text-fg-muted">Buyer</dt>
        <dd>{ANONYMOUS_BUYER}</dd>
        <dt className="text-fg-muted">Source</dt>
        <dd className="flex items-center gap-2">
          <SourceBadge source={order.source === "STAFF" ? "staff" : "player"} />
        </dd>
        <dt className="text-fg-muted">Status</dt>
        <dd>
          {order.status === "REVERSED" ? (
            <Badge tone="danger">Reversed</Badge>
          ) : (
            <Badge tone="success">Completed</Badge>
          )}
        </dd>
        {order.couponCode ? (
          <>
            <dt className="text-fg-muted">Coupon used</dt>
            <dd>
              <code className="font-mono">{order.couponCode}</code>
            </dd>
          </>
        ) : order.couponKind === "PRIVATE" ? (
          <>
            <dt className="text-fg-muted">Coupon used</dt>
            <dd>Private coupon</dd>
          </>
        ) : null}
      </dl>

      <section
        aria-labelledby="od-money"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <Heading level={2} size="sm" id="od-money">
          What you earned
        </Heading>
        <OrderEquation
          listPaise={parsePaise(order.listPaise)}
          discountPaise={parsePaise(order.discountPaise)}
          feePaise={parsePaise(order.feePaise)}
          deliverySellerPaise={parsePaise(order.deliveryFeeSellerPaise)}
        />
        <p className="text-lg">
          Net earnings: <Price amountPaise={parsePaise(order.netPaise)} display="exact" className="text-lg" />
        </p>
        {buyerFee > 0n ? (
          <Text size="sm" muted>
            Delivery fee paid by the buyer:{" "}
            <Price amountPaise={buyerFee} display="exact" className="text-sm" /> (not your revenue).
          </Text>
        ) : null}
      </section>

      <section aria-labelledby="od-lines" className="flex flex-col gap-3">
        <Heading level={2} size="sm" id="od-lines">
          Items
        </Heading>
        <DataTable
          caption="Items in this order"
          rows={order.lines}
          rowKey={(l) => `${l.productId}-${l.editionSerial ?? 0}`}
          columns={[
            {
              key: "name",
              header: "Product",
              cell: (l) => (
                <span className="break-words">
                  {l.name}
                  {l.editionSerial ? ` (edition #${l.editionSerial})` : ""}
                </span>
              ),
            },
            {
              key: "list",
              header: "List price",
              align: "right",
              cell: (l) => <Price amountPaise={parsePaise(l.listPaise)} display="exact" />,
            },
            {
              key: "discount",
              header: "Discount",
              align: "right",
              cell: (l) => <Price amountPaise={parsePaise(l.discountPaise)} display="exact" />,
            },
            {
              key: "fee",
              header: "Fee",
              align: "right",
              cell: (l) => <Price amountPaise={parsePaise(l.feePaise)} display="exact" />,
            },
          ]}
        />
      </section>

      <section aria-labelledby="od-delivery" className="flex flex-col gap-3">
        <Heading level={2} size="sm" id="od-delivery">
          Delivery
        </Heading>
        {order.delivery ? (
          <>
            <Text size="sm" muted>
              {SPEED_COPY[order.delivery.speed].name} delivery. The courier is simulated.
            </Text>
            <TrackingTimeline stages={trackingStages(order.delivery, Date.now())} />
          </>
        ) : (
          <Alert tone="info">No delivery for this order.</Alert>
        )}
      </section>
    </>
  );
}
