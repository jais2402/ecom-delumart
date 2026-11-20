import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CREATOR_THRESHOLD_PAISE, rupees } from "../money/index";
import { brandQualifies, COLLECTOR_LEVELS, collectorLevel, shouldUnlockCreator } from "./index";

describe("shouldUnlockCreator (US-04)", () => {
  it("US-04: exactly ₹1 crore stays locked", () => {
    expect(shouldUnlockCreator(1_000_000_000n)).toBe(false);
  });
  it("US-04: one paise below ₹1 crore unlocks", () => {
    expect(shouldUnlockCreator(999_999_999n)).toBe(true);
  });
  it("US-04: one paise above ₹1 crore stays locked", () => {
    expect(shouldUnlockCreator(1_000_000_001n)).toBe(false);
  });
  it("unlocks iff strictly below the threshold (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 14n }), (b) => {
        expect(shouldUnlockCreator(b)).toBe(b < CREATOR_THRESHOLD_PAISE);
      }),
    );
  });
});

describe("collectorLevel (US-31)", () => {
  it("US-31: thresholds 0/5/15/30/60/100 map to levels 1–6", () => {
    const cases: [number, number][] = [
      [0, 1],
      [4, 1],
      [5, 2],
      [14, 2],
      [15, 3],
      [29, 3],
      [30, 4],
      [59, 4],
      [60, 5],
      [99, 5],
      [100, 6],
      [10_000, 6],
    ];
    for (const [items, level] of cases) expect(collectorLevel(items).level, String(items)).toBe(level);
  });

  it("US-31: exact titles and next threshold at each level boundary", () => {
    expect(collectorLevel(0)).toEqual({ level: 1, title: "New Arrival", nextAt: 5 });
    expect(collectorLevel(5)).toEqual({ level: 2, title: "Curious Collector", nextAt: 15 });
    expect(collectorLevel(15)).toEqual({ level: 3, title: "Curator", nextAt: 30 });
    expect(collectorLevel(30)).toEqual({ level: 4, title: "Vault Builder", nextAt: 60 });
    expect(collectorLevel(60)).toEqual({ level: 5, title: "Grand Collector", nextAt: 100 });
    expect(collectorLevel(100)).toEqual({ level: 6, title: "Delulu Legend", nextAt: null });
    expect(COLLECTOR_LEVELS.map((l) => l.title)).toEqual([
      "New Arrival",
      "Curious Collector",
      "Curator",
      "Vault Builder",
      "Grand Collector",
      "Delulu Legend",
    ]);
  });

  it("level never decreases as the collection grows (property)", () => {
    fc.assert(
      fc.property(fc.nat({ max: 500 }), (n) => {
        expect(collectorLevel(n + 1).level).toBeGreaterThanOrEqual(collectorLevel(n).level);
      }),
    );
  });

  it("rejects negative or fractional counts", () => {
    expect(() => collectorLevel(-1)).toThrow();
    expect(() => collectorLevel(1.5)).toThrow();
  });
});

describe("brandQualifies (US-20)", () => {
  const TEN_CRORE = rupees(100_000_000n);
  it("US-20: qualifies at exactly ₹10 crore and 5 buyers", () => {
    expect(brandQualifies({ grossPaise: TEN_CRORE, distinctEligibleBuyers: 5 })).toBe(true);
  });
  it("US-20: one paise short does not qualify", () => {
    expect(brandQualifies({ grossPaise: TEN_CRORE - 1n, distinctEligibleBuyers: 5 })).toBe(false);
  });
  it("US-20: four buyers do not qualify", () => {
    expect(brandQualifies({ grossPaise: TEN_CRORE * 10n, distinctEligibleBuyers: 4 })).toBe(false);
  });
});
