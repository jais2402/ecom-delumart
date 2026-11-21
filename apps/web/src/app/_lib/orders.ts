import type { TrackingStage } from "@delulu/ui";
import type { OrderResponse, SellerOrder } from "./api";
import { parsePaise } from "./money";

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const STAGES = [
  ["placed", "Order placed", "placedAt"],
  ["packed", "Packed", "packedAt"],
  ["shipped", "On the way", "shippedAt"],
  ["out", "Nearby", "outAt"],
  ["delivered", "Delivered", "deliveredAt"],
] as const;

/** Tracking stages computed from the shipment's timestamps and the current time. */
export function trackingStages(shipment: NonNullable<SellerOrder["shipment"]>, now: number): TrackingStage[] {
  const cancelled = shipment.cancelledAt !== null;
  let currentAssigned = false;
  return STAGES.map(([key, title, field]) => {
    const at = shipment[field];
    const reached = Date.parse(at) <= now;
    let state: TrackingStage["state"];
    if (reached) state = "done";
    else if (!currentAssigned && !cancelled) {
      state = "current";
      currentAssigned = true;
    } else state = "upcoming";
    return {
      key,
      title,
      state,
      dateTime: at,
      time: reached ? formatWhen(at) : `Expected ${formatWhen(at)}`,
      ...(cancelled && state !== "done" ? { note: "Cancelled" } : {}),
    };
  });
}

/** Totals across all seller orders of one order. */
export function orderTotals(order: OrderResponse) {
  let items = 0n;
  let discount = 0n;
  let delivery = 0n;
  for (const so of order.sellerOrders) {
    items += parsePaise(so.listPaise);
    discount += parsePaise(so.sellerDiscountPaise) + parsePaise(so.platformDiscountPaise);
    delivery += parsePaise(so.deliveryFeePaise);
  }
  return { items, discount, delivery, total: parsePaise(order.totalPaise) };
}

export function statusLabel(status: string): string {
  const text = status.toLowerCase().replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
