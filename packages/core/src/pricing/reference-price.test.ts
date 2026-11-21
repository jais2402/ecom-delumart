import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/index";
import { rupees } from "../money/index";
import { type PricePoint, REFERENCE_PRICE_RULES, referencePrice } from "./reference-price";

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const at = (hours: number, extraMs = 0) => new Date(T0 + hours * HOUR + extraMs);
const p = (r: bigint, hours: number, extraMs = 0): PricePoint => ({
  pricePaise: rupees(r),
  at: at(hours, extraMs),
});

describe("referencePrice (sale price display rule)", () => {
  it("US-43: a cut after exactly 24 hours at the earlier price shows the earlier price", () => {
    expect(referencePrice([p(1000n, 0), p(800n, 24)])).toBe(rupees(1000n));
  });

  it("US-43: one millisecond short of 24 hours shows nothing", () => {
    expect(referencePrice([p(1000n, 0), p(800n, 23, HOUR - 1)])).toBeNull();
  });

  it("US-43: a price increase never shows a reference, however long the earlier price was live", () => {
    expect(referencePrice([p(800n, 0), p(1000n, 500)])).toBeNull();
    expect(referencePrice([p(1000n, 0), p(1000n, 100)])).toBeNull();
  });

  it("US-43: only the price immediately before counts (an older, higher price does not)", () => {
    // 2,000 for days, 900 for one hour, then 800: the run right before the cut was 1 hour long
    expect(referencePrice([p(2000n, 0), p(900n, 200), p(800n, 201)])).toBeNull();
    // ... and a later increase hides the reference again
    expect(referencePrice([p(1000n, 0), p(800n, 48), p(1200n, 96)])).toBeNull();
  });

  it("US-43: entries that kept the same price are one continuous run", () => {
    // 1,000 published, a revision at the same price 20 h later, the cut 30 h after publication
    expect(referencePrice([p(1000n, 0), p(1000n, 20), p(800n, 30)])).toBe(rupees(1000n));
    // the current price's own repeated entries do not move when it took effect
    expect(referencePrice([p(1000n, 0), p(800n, 30), p(800n, 31)])).toBe(rupees(1000n));
  });

  it("US-43: a listing hidden while the earlier price was live breaks the 24 continuous hours", () => {
    const history = [p(1000n, 0), p(800n, 48)];
    expect(referencePrice(history, { offSale: [{ from: at(10), to: at(11) }] })).toBeNull();
    expect(referencePrice(history, { offSale: [{ from: at(40), to: null }] })).toBeNull();
    // hidden before the earlier price took effect, or only after the cut: still continuous
    expect(referencePrice(history, { offSale: [{ from: at(-5), to: at(0) }] })).toBe(rupees(1000n));
    expect(referencePrice(history, { offSale: [{ from: at(48), to: at(50) }] })).toBe(rupees(1000n));
  });

  it("no history or a single price shows nothing", () => {
    expect(referencePrice([])).toBeNull();
    expect(referencePrice([p(1000n, 0)])).toBeNull();
  });

  it("refuses out-of-order or non-positive history", () => {
    expect(() => referencePrice([p(1000n, 10), p(800n, 0)])).toThrow(DomainError);
    expect(() => referencePrice([{ pricePaise: 0n, at: at(0) }])).toThrow(DomainError);
    expect(() => referencePrice([p(1000n, 0)], { minHours: -1 })).toThrow(DomainError);
  });

  it("property: a reference, when shown, is higher than the current price and was live for at least the minimum", () => {
    const step = fc.record({
      rupees: fc.bigInt({ min: 100n, max: 5_000n }),
      gapHours: fc.integer({ min: 0, max: 72 }),
    });
    fc.assert(
      fc.property(fc.array(step, { minLength: 0, maxLength: 12 }), (steps) => {
        let hours = 0;
        const history = steps.map((s) => {
          hours += s.gapHours;
          return p(s.rupees, hours);
        });
        const ref = referencePrice(history);
        if (ref === null) return;
        const current = history.at(-1) as PricePoint;
        expect(ref > current.pricePaise).toBe(true);
        // the reference is the price of the run right before the current price's run
        let i = history.length - 1;
        while (i > 0 && (history[i - 1] as PricePoint).pricePaise === current.pricePaise) i--;
        const before = history[i - 1] as PricePoint;
        expect(before.pricePaise).toBe(ref);
        let j = i - 1;
        while (j > 0 && (history[j - 1] as PricePoint).pricePaise === ref) j--;
        const liveHours =
          ((history[i] as PricePoint).at.getTime() - (history[j] as PricePoint).at.getTime()) / HOUR;
        expect(liveHours).toBeGreaterThanOrEqual(REFERENCE_PRICE_RULES.minHours);
      }),
    );
  });

  it("property: appending a higher price always removes the reference", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 100n, max: 5_000n }), { minLength: 1, maxLength: 8 }),
        fc.bigInt({ min: 1n, max: 1_000n }),
        (prices, up) => {
          const history = prices.map((r, i) => p(r, i * 30));
          const last = (history.at(-1) as PricePoint).pricePaise;
          history.push({ pricePaise: last + up, at: at(prices.length * 30 + 30) });
          expect(referencePrice(history)).toBeNull();
        },
      ),
    );
  });
});
