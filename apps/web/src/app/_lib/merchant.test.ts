import { describe, expect, it } from "vitest";
import { changeText, countChangeText, describeCoupon } from "./merchant";

describe("changeText", () => {
  it("shows the absolute change and a percentage against a non-zero baseline", () => {
    expect(changeText(125_000n, 100_000n, 7)).toBe("+₹250 (+25%) vs the previous 7 days");
    expect(changeText(50_000n, 100_000n, 7)).toBe("−₹500 (−50%) vs the previous 7 days");
  });
  it("says there is no baseline instead of a percentage when the previous value is zero", () => {
    expect(changeText(100_000n, 0n, 7)).toBe("+₹1,000 vs the previous 7 days. No prior baseline.");
    expect(changeText(0n, 0n, 7)).toContain("No prior baseline");
    expect(changeText(100_000n, 0n, 7)).not.toContain("%");
  });
  it("handles no change", () => {
    expect(changeText(5n, 5n, 30)).toBe("No change vs the previous 30 days");
  });
});

describe("countChangeText", () => {
  it("counts orders with a percentage, or no baseline", () => {
    expect(countChangeText(3, 2, 7)).toBe("+1 (+50%) vs the previous 7 days");
    expect(countChangeText(1, 0, 7)).toBe("+1 vs the previous 7 days. No prior baseline.");
  });
});

describe("describeCoupon", () => {
  it("lists terms in plain words", () => {
    expect(
      describeCoupon({
        kind: "PERCENT",
        percent: 10,
        amountPaise: null,
        minSpendPaise: "100000",
        startsAt: null,
        endsAt: null,
        maxRedemptions: 50,
      }),
    ).toEqual(["10% off", "Minimum spend ₹1,000", "First 50 uses"]);
  });
});
