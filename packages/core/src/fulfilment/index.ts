/**
 * Delivery stages (LLD §5.7). Timestamps are epoch milliseconds supplied by the caller.
 */
import { DomainError } from "../errors/index";

export type DeliverySpeed = "STANDARD" | "EXPRESS" | "ZAP";
export type DeliveryDurationsMs = Readonly<Record<DeliverySpeed, number>>;

export const DEFAULT_DELIVERY_DURATIONS_MS: DeliveryDurationsMs = {
  STANDARD: 24 * 60 * 60_000,
  EXPRESS: 2 * 60 * 60_000,
  ZAP: 10 * 60_000,
};

export const SHIPMENT_STAGES = [
  "PLACED",
  "PACKED",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
] as const;
export type ShipmentStage = (typeof SHIPMENT_STAGES)[number];

export type ShipmentSchedule = {
  placedAt: number;
  packedAt: number;
  shippedAt: number;
  outForDeliveryAt: number;
  deliveredAt: number;
};

/** placed = T; packed = T + 10%; shipped = T + 30%; out = T + 70%; delivered = T + 100% (floored ms). */
export function computeShipmentSchedule(
  speed: DeliverySpeed,
  placedAt: number,
  durations: DeliveryDurationsMs = DEFAULT_DELIVERY_DURATIONS_MS,
): ShipmentSchedule {
  const d = durations[speed];
  if (!Number.isSafeInteger(d) || d < 0 || !Number.isSafeInteger(placedAt)) {
    throw new DomainError("VALIDATION_FAILED", "durations and timestamps must be whole milliseconds");
  }
  const at = (pct: number) => placedAt + Math.floor((d * pct) / 100);
  return {
    placedAt,
    packedAt: at(10),
    shippedAt: at(30),
    outForDeliveryAt: at(70),
    deliveredAt: placedAt + d,
  };
}

/** Last stage whose timestamp ≤ now, or CANCELLED when cancelledAt is set. */
export function currentStage(
  schedule: ShipmentSchedule & { cancelledAt?: number | null },
  now: number,
): ShipmentStage {
  if (schedule.cancelledAt !== undefined && schedule.cancelledAt !== null) return "CANCELLED";
  if (now >= schedule.deliveredAt) return "DELIVERED";
  if (now >= schedule.outForDeliveryAt) return "OUT_FOR_DELIVERY";
  if (now >= schedule.shippedAt) return "SHIPPED";
  if (now >= schedule.packedAt) return "PACKED";
  return "PLACED";
}
