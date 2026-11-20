import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  computeShipmentSchedule,
  currentStage,
  DEFAULT_DELIVERY_DURATIONS_MS,
  SHIPMENT_STAGES,
} from "./index";

const H = 3_600_000;
const T = 1_800_000_000_000;

describe("computeShipmentSchedule", () => {
  it("Standard: 10/30/70/100% of 24 h", () => {
    expect(computeShipmentSchedule("STANDARD", T)).toEqual({
      placedAt: T,
      packedAt: T + 2.4 * H,
      shippedAt: T + 7.2 * H,
      outForDeliveryAt: T + 16.8 * H,
      deliveredAt: T + 24 * H,
    });
  });

  it("Express is 2 h and Zap is 10 min by default", () => {
    expect(computeShipmentSchedule("EXPRESS", T).deliveredAt).toBe(T + 2 * H);
    expect(computeShipmentSchedule("ZAP", T).deliveredAt).toBe(T + 10 * 60_000);
    expect(computeShipmentSchedule("ZAP", T).packedAt).toBe(T + 60_000);
  });

  it("durations come from config", () => {
    expect(
      computeShipmentSchedule("ZAP", T, { ...DEFAULT_DELIVERY_DURATIONS_MS, ZAP: 1000 }).deliveredAt,
    ).toBe(T + 1000);
  });
});

describe("currentStage", () => {
  it("is Delivered exactly at the promised time and Out for delivery 1 ms before", () => {
    for (const speed of ["STANDARD", "EXPRESS", "ZAP"] as const) {
      const s = computeShipmentSchedule(speed, T);
      expect(currentStage(s, s.deliveredAt)).toBe("DELIVERED");
      expect(currentStage(s, s.deliveredAt - 1)).toBe("OUT_FOR_DELIVERY");
    }
  });

  it("is Placed at commit time and before it", () => {
    const s = computeShipmentSchedule("STANDARD", T);
    expect(currentStage(s, T)).toBe("PLACED");
    expect(currentStage(s, T - 5)).toBe("PLACED");
  });

  it("is Cancelled whenever cancelledAt is set", () => {
    const s = computeShipmentSchedule("STANDARD", T);
    expect(currentStage({ ...s, cancelledAt: T + H }, T + 30 * H)).toBe("CANCELLED");
    expect(currentStage({ ...s, cancelledAt: null }, T + 30 * H)).toBe("DELIVERED");
  });

  it("stages never go backwards as time moves forward (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("STANDARD" as const, "EXPRESS" as const, "ZAP" as const),
        fc.array(fc.integer({ min: -H, max: 30 * H }), { minLength: 2, maxLength: 20 }),
        (speed, offsets) => {
          const s = computeShipmentSchedule(speed, T);
          const ranks = [...offsets]
            .sort((a, b) => a - b)
            .map((o) => SHIPMENT_STAGES.indexOf(currentStage(s, T + o)));
          for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1] ?? 0);
        },
      ),
    );
  });

  it("timestamps are non-decreasing for any duration (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 ** 9 }), fc.integer({ min: 0, max: 2 * 10 ** 12 }), (d, t) => {
        const s = computeShipmentSchedule("ZAP", t, { ...DEFAULT_DELIVERY_DURATIONS_MS, ZAP: d });
        const ts = [s.placedAt, s.packedAt, s.shippedAt, s.outForDeliveryAt, s.deliveredAt];
        for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1] ?? 0);
        expect(s.deliveredAt).toBe(t + d);
      }),
    );
  });
});
