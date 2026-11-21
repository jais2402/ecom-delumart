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

export interface DeliveryStatus {
  label: "Delivered" | "Arriving" | "Cancelled" | "Preparing";
  tone: "success" | "info" | "danger" | "neutral";
  /** e.g. "Expected 21 Nov 2026, 4:10 pm"; empty when there is nothing to add. */
  detail: string;
}

type Shipment = NonNullable<SellerOrder["shipment"]>;

/**
 * Delivery status from the shipment's timestamps and the current time, never from the order's
 * payment status ("Completed" there only means the payment went through).
 */
export function deliveryStatus(shipment: Shipment | null, now: number): DeliveryStatus {
  if (shipment === null) return { label: "Preparing", tone: "neutral", detail: "" };
  if (shipment.cancelledAt !== null) return { label: "Cancelled", tone: "danger", detail: "" };
  if (Date.parse(shipment.deliveredAt) <= now) {
    return { label: "Delivered", tone: "success", detail: formatWhen(shipment.deliveredAt) };
  }
  return { label: "Arriving", tone: "info", detail: `Expected ${formatWhen(shipment.deliveredAt)}` };
}

/** One status for a whole order: Delivered only when every seller order has arrived. */
export function orderDeliveryStatus(order: OrderResponse, now: number): DeliveryStatus {
  const statuses = order.sellerOrders.map((so) => deliveryStatus(so.shipment, now));
  const open = order.sellerOrders.filter(
    (so, i) => statuses[i]?.label === "Arriving" && so.shipment !== null,
  );
  if (open.length > 0) {
    const last = open
      .map((so) => (so.shipment as Shipment).deliveredAt)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] as string;
    return { label: "Arriving", tone: "info", detail: `Expected ${formatWhen(last)}` };
  }
  return (
    statuses.find((s) => s.label !== "Delivered") ??
    statuses[0] ?? { label: "Preparing", tone: "neutral", detail: "" }
  );
}
