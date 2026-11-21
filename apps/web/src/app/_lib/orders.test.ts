import { describe, expect, it } from "vitest";
import type { OrderResponse, SellerOrder } from "./api";
import { deliveryStatus, orderDeliveryStatus } from "./orders";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const shipment = (deliveredInHours: number, cancelled = false): NonNullable<SellerOrder["shipment"]> => ({
  speed: "STANDARD",
  placedAt: at(-30),
  packedAt: at(-28),
  shippedAt: at(-26),
  outAt: at(-25),
  deliveredAt: at(deliveredInHours),
  cancelledAt: cancelled ? at(-1) : null,
});
const order = (...ships: (NonNullable<SellerOrder["shipment"]> | null)[]): OrderResponse => ({
  id: "o",
  createdAt: at(-30),
  totalPaise: "1",
  paymentReference: "r",
  sellerOrders: ships.map((shipmentOf, i) => ({
    id: `s${i}`,
    sellerType: "SEED",
    sellerName: null,
    status: "COMPLETED",
    listPaise: "1",
    sellerDiscountPaise: "0",
    platformDiscountPaise: "0",
    deliveryFeePaise: "0",
    totalPaise: "1",
    shipment: shipmentOf,
    lines: [],
  })),
});

describe("delivery status", () => {
  it("is derived from the shipment times, never from the payment status", () => {
    expect(deliveryStatus(shipment(3), NOW)).toMatchObject({ label: "Arriving", tone: "info" });
    expect(deliveryStatus(shipment(3), NOW).detail).toMatch(/^Expected /);
    expect(deliveryStatus(shipment(-1), NOW)).toMatchObject({ label: "Delivered", tone: "success" });
    expect(deliveryStatus(shipment(3, true), NOW).label).toBe("Cancelled");
    expect(deliveryStatus(null, NOW).label).toBe("Preparing");
  });
  it("an order is Delivered only when every seller order has arrived", () => {
    expect(orderDeliveryStatus(order(shipment(-1), shipment(-2)), NOW).label).toBe("Delivered");
    expect(orderDeliveryStatus(order(shipment(-1), shipment(5)), NOW).label).toBe("Arriving");
  });
});
