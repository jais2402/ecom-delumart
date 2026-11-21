import { Badge, Price } from "@delulu/ui";
import type { OrderResponse } from "../../_lib/api";
import { parsePaise } from "../../_lib/money";
import { formatWhen, orderDeliveryStatus } from "../../_lib/orders";

/** One order as a row: what, when, how much, status and a link to the detail page. */
export function OrderRow({ order }: { order: OrderResponse }) {
  const names = order.sellerOrders.flatMap((so) => so.lines.map((l) => l.name)).join(", ");
  const stores = [...new Set(order.sellerOrders.map((so) => so.sellerName ?? "DeluluMart Originals"))].join(
    ", ",
  );
  const delivery = orderDeliveryStatus(order, Date.now());
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 break-words font-medium text-fg">{names || "Order"}</p>
        <Price amountPaise={parsePaise(order.totalPaise)} display="exact" />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
        <span>From {stores}</span>
        <time dateTime={order.createdAt}>{formatWhen(order.createdAt)}</time>
        <Badge tone={delivery.tone}>{delivery.label}</Badge>
        {delivery.detail ? <span>{delivery.detail}</span> : null}
      </div>
      <a
        href={`/orders/${order.id}`}
        aria-label={`View order: ${names || order.paymentReference}`}
        className="inline-flex min-h-touch items-center self-start text-action underline"
      >
        View order
      </a>
    </article>
  );
}
