import { Badge, Price, ProductPicture } from "@delulu/ui";
import type { OrderResponse } from "../../_lib/api";
import { parsePaise } from "../../_lib/money";
import { formatWhen, orderDeliveryStatus } from "../../_lib/orders";
import { photoSrcOf } from "../../_lib/product-photos";
import { useProducts } from "../../_lib/use-products";

const THUMBS = 4;

/** One order as a row: its pictures, what, when, how much, status and a link to the detail page. */
export function OrderRow({ order }: { order: OrderResponse }) {
  const lines = order.sellerOrders.flatMap((so) => so.lines);
  const names = lines.map((l) => l.name).join(", ");
  const stores = [...new Set(order.sellerOrders.map((so) => so.sellerName ?? "DeluluMart Originals"))].join(
    ", ",
  );
  const delivery = orderDeliveryStatus(order, Date.now());
  const shown = lines.slice(0, THUMBS);
  const { products } = useProducts(shown.map((l) => l.productId));
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 break-words font-medium text-fg">{names || "Order"}</p>
        <Price amountPaise={parsePaise(order.totalPaise)} display="exact" />
      </div>
      {shown.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-2">
          {shown.map((line) => {
            const product = products.get(line.productId);
            return (
              <li key={line.id}>
                <ProductPicture
                  imageSrc={product ? photoSrcOf(product) : undefined}
                  hue={product?.templateId ?? 0}
                  seed={line.name}
                  alt=""
                  className="size-14"
                />
              </li>
            );
          })}
          {lines.length > shown.length ? (
            <li className="text-sm text-fg-muted">+{lines.length - shown.length} more</li>
          ) : null}
        </ul>
      ) : null}
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
