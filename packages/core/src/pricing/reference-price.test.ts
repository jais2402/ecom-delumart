import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/index";
import { rupees } from "../money/index";
import { type PricePoint, REFERENCE_PRICE_RULES, referenceCeiling, referencePrice } from "./reference-price";

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (hours: number, extraMs = 0) => new Date(T0 + hours * HOUR + extraMs);
const p = (r: bigint, hours: number, extraMs = 0): PricePoint => ({
  pricePaise: rupees(r),
  at: at(hours, extraMs),
});

/**
 * The reference ("was") price is the LOWEST price the product was published at in the lookback
 * window (30 days) before the current price took effect (EU Omnibus style), shown only when it is
 * above the current price and the product was published for at least 24 hours in that window.
 */
describe("referencePrice (lowest prior price rule, US-43)", () => {
  it("US-43: a cut after exactly 24 hours at the earlier price shows the earlier price", () => {
    expect(referencePrice([p(1000n, 0), p(800n, 24)])).toBe(rupees(1000n));
  });

  it("US-43: one millisecond short of 24 published hours shows nothing", () => {
    expect(referencePrice([p(1000n, 0), p(800n, 23, HOUR - 1)])).toBeNull();
  });

  it("US-43: a price increase never shows a reference, however long the earlier price was live", () => {
    expect(referencePrice([p(800n, 0), p(1000n, 500)])).toBeNull();
    expect(referencePrice([p(1000n, 0), p(1000n, 100)])).toBeNull();
  });

  it("US-43: the reference is the lowest price of the window, not the price right before", () => {
    // 2,000 for days, 900 for an hour, then 800: "was" is the lowest earlier price, 900
    expect(referencePrice([p(2000n, 0), p(900n, 200), p(800n, 201)])).toBe(rupees(900n));
    // an earlier, lower price wins over the price right before the cut
    expect(referencePrice([p(700n, 0), p(1000n, 50), p(800n, 100)])).toBeNull();
    expect(referencePrice([p(1000n, 0), p(900n, 50), p(1500n, 100), p(800n, 150)])).toBe(rupees(900n));
  });

  it("US-43 (review major 1): raising the price first and cutting later shows no reference above the 30-day low", () => {
    // 1,000 for a day, raised to 100,000 for 25 hours, then a "sale" at 50,000
    expect(referencePrice([p(1000n, 0), p(100_000n, 25), p(50_000n, 50)])).toBeNull();
    // inside a sale: sale 600, raised to 900 for 25 hours, dropped to 650
    expect(referencePrice([p(1000n, 0), p(600n, 30), p(900n, 31), p(650n, 56)])).toBeNull();
  });

  it("US-43: a later increase hides the reference again", () => {
    expect(referencePrice([p(1000n, 0), p(800n, 48), p(1200n, 96)])).toBeNull();
  });

  it("US-43: entries that kept the same price are one continuous run", () => {
    expect(referencePrice([p(1000n, 0), p(1000n, 20), p(800n, 30)])).toBe(rupees(1000n));
    // the current price's own repeated entries do not move when it took effect
    expect(referencePrice([p(1000n, 0), p(800n, 30), p(800n, 31)])).toBe(rupees(1000n));
  });

  it("US-43: only the 30 days before the current price count; an older lower price is forgotten", () => {
    // 500 long ago (day 0), 1,000 from day 10, cut to 800 on day 45: window day 15 to 45 holds only 1,000
    expect(referencePrice([p(500n, 0), p(1000n, 240), p(800n, 45 * 24)])).toBe(rupees(1000n));
    // the same low price inside the window blocks it
    expect(referencePrice([p(500n, 0), p(1000n, 240), p(800n, 39 * 24)])).toBeNull();
  });

  it("US-43: a product published for less than the window uses its whole history", () => {
    expect(referencePrice([p(1000n, 0), p(800n, 48)], { lookbackDays: 30 })).toBe(rupees(1000n));
    expect(referencePrice([p(1000n, 0), p(800n, 48)], { lookbackDays: 1 })).toBe(rupees(1000n));
  });

  it("US-43: a hidden period counts as no price: it neither sets the minimum nor breaks the 24 hours", () => {
    const history = [p(1000n, 0), p(800n, 48)];
    // hidden for an hour: 47 published hours remain, the reference still shows
    expect(referencePrice(history, { offSale: [{ from: at(10), to: at(11) }] })).toBe(rupees(1000n));
    expect(referencePrice(history, { offSale: [{ from: at(40), to: null }] })).toBe(rupees(1000n));
    // hidden so long that under 24 published hours remain: nothing
    expect(referencePrice(history, { offSale: [{ from: at(10), to: at(40) }] })).toBeNull();
    // a hidden stretch at a low price removes that price from the minimum
    const low = [p(1000n, 0), p(500n, 30), p(1000n, 40), p(800n, 80)];
    expect(referencePrice(low)).toBeNull();
    expect(referencePrice(low, { offSale: [{ from: at(30), to: at(40) }] })).toBe(rupees(1000n));
  });

  it("no history or a single price shows nothing", () => {
    expect(referencePrice([])).toBeNull();
    expect(referencePrice([p(1000n, 0)])).toBeNull();
  });

  it("refuses out-of-order or non-positive history and bad options", () => {
    expect(() => referencePrice([p(1000n, 10), p(800n, 0)])).toThrow(DomainError);
    expect(() => referencePrice([{ pricePaise: 0n, at: at(0) }])).toThrow(DomainError);
    expect(() => referencePrice([p(1000n, 0)], { minHours: -1 })).toThrow(DomainError);
    expect(() => referencePrice([p(1000n, 0)], { lookbackDays: 0 })).toThrow(DomainError);
  });

  const stepArb = fc.record({
    rupees: fc.bigInt({ min: 100n, max: 5_000n }),
    gapHours: fc.integer({ min: 0, max: 400 }),
  });
  const build = (steps: { rupees: bigint; gapHours: number }[]): PricePoint[] => {
    let hours = 0;
    return steps.map((s) => {
      hours += s.gapHours;
      return p(s.rupees, hours);
    });
  };

  it("property: a reference is above the current price and is the minimum price of the lookback window", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 12 }), (steps) => {
        const history = build(steps);
        const ref = referencePrice(history);
        if (ref === null) return;
        const current = history.at(-1) as PricePoint;
        expect(ref > current.pricePaise).toBe(true);
        // no price in the 30 days before the current run was lower than the reference
        let i = history.length - 1;
        while (i > 0 && (history[i - 1] as PricePoint).pricePaise === current.pricePaise) i--;
        const start = (history[i] as PricePoint).at.getTime();
        const prior = history.slice(0, i).filter((h, k) => {
          const end = (history[k + 1] as PricePoint).at.getTime();
          return (
            end > start - REFERENCE_PRICE_RULES.lookbackDays * DAY &&
            h.at.getTime() < start &&
            end > h.at.getTime()
          );
        });
        expect(prior.length).toBeGreaterThan(0);
        const lowest = prior.map((h) => h.pricePaise).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
        expect(lowest).toBe(ref);
      }),
      { numRuns: 400 },
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

describe("referenceCeiling (what a price set now would be compared with)", () => {
  it("US-43: the lowest price of the window including the current price, once published 24 hours", () => {
    expect(referenceCeiling([p(1000n, 0)], at(24))).toBe(rupees(1000n));
    expect(referenceCeiling([p(1000n, 0)], at(23))).toBeNull();
    expect(referenceCeiling([p(1000n, 0), p(800n, 30)], at(40))).toBe(rupees(800n));
    expect(referenceCeiling([], at(40))).toBeNull();
  });

  it("US-43: a price below the ceiling set now gets a reference equal to the ceiling; one at or above does not", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            rupees: fc.bigInt({ min: 100n, max: 5_000n }),
            gapHours: fc.integer({ min: 0, max: 200 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.integer({ min: 0, max: 100 }),
        fc.bigInt({ min: 100n, max: 5_000n }),
        (steps, idle, next) => {
          let hours = 0;
          const history = steps.map((s) => {
            hours += s.gapHours;
            return p(s.rupees, hours);
          });
          fc.pre(rupees(next) !== (history.at(-1) as PricePoint).pricePaise);
          const now = at(hours + idle);
          const ceiling = referenceCeiling(history, now);
          const after = [...history, { pricePaise: rupees(next), at: now }];
          const ref = referencePrice(after);
          if (ceiling !== null && rupees(next) < ceiling) expect(ref).toBe(ceiling);
          else expect(ref).toBeNull();
        },
      ),
      { numRuns: 400 },
    );
  });
});
