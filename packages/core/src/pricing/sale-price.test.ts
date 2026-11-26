import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/index";
import { MAX_PRICE_PAISE, MIN_PRICE_PAISE, rupees } from "../money/index";
import { type PricePoint, referencePrice } from "./reference-price";
import { requireReferencePrice, salePriceProblem } from "./sale-price";

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const p = (r: bigint, hours: number): PricePoint => ({
  pricePaise: rupees(r),
  at: new Date(T0 + hours * HOUR),
});

describe("salePriceProblem (R6.2)", () => {
  it("US-43: a sale price is strictly lower than the list price", () => {
    expect(salePriceProblem(rupees(1000n), rupees(800n))).toBeNull();
    expect(salePriceProblem(rupees(1000n), rupees(1000n))).toBe("NOT_LOWER");
    expect(salePriceProblem(rupees(1000n), rupees(1200n))).toBe("NOT_LOWER");
  });

  it("US-43: a sale price keeps the listing price rules (whole rupees, minimum to maximum price)", () => {
    expect(salePriceProblem(rupees(1000n), MIN_PRICE_PAISE)).toBeNull();
    expect(salePriceProblem(rupees(1000n), MIN_PRICE_PAISE - 100n)).toBe("OUT_OF_RANGE");
    expect(salePriceProblem(rupees(1000n), rupees(800n) + 50n)).toBe("OUT_OF_RANGE");
    expect(salePriceProblem(MAX_PRICE_PAISE, MAX_PRICE_PAISE - 100n)).toBeNull();
    expect(salePriceProblem(MAX_PRICE_PAISE, 0n)).toBe("OUT_OF_RANGE");
  });
});

describe("requireReferencePrice (REFERENCE_PRICE_INELIGIBLE)", () => {
  it("US-43: returns the reference when the earlier price was live for 24 hours", () => {
    expect(requireReferencePrice([p(1000n, 0), p(800n, 24)])).toBe(rupees(1000n));
  });

  it("US-43: refuses with REFERENCE_PRICE_INELIGIBLE otherwise", () => {
    for (const history of [[p(1000n, 0), p(800n, 23)], [p(1000n, 0)], [p(800n, 0), p(1000n, 99)]]) {
      try {
        requireReferencePrice(history);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(DomainError);
        expect((e as DomainError).code).toBe("REFERENCE_PRICE_INELIGIBLE");
      }
    }
  });
});

/**
 * A model of the seller's price actions on a live listing: a list price change (not while on
 * sale), a sale, ending the sale (back to the list price). Each action takes effect `gap` hours
 * after the previous one.
 */
type Action =
  | { kind: "LIST"; price: bigint; gap: number }
  | { kind: "SALE"; cut: bigint; gap: number }
  | { kind: "END"; gap: number };
const gapArb = fc.integer({ min: 0, max: 80 });
const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({
    kind: fc.constant("LIST" as const),
    price: fc.bigInt({ min: 100n, max: 5000n }),
    gap: gapArb,
  }),
  fc.record({ kind: fc.constant("SALE" as const), cut: fc.bigInt({ min: 1n, max: 99n }), gap: gapArb }),
  fc.record({ kind: fc.constant("END" as const), gap: gapArb }),
);

function play(actions: readonly Action[]): { history: PricePoint[]; listPaise: bigint; onSale: boolean } {
  let list = rupees(1000n);
  let sale: bigint | null = null;
  let hour = 0;
  const history: PricePoint[] = [{ pricePaise: list, at: new Date(T0) }];
  const push = (price: bigint) => history.push({ pricePaise: price, at: new Date(T0 + hour * HOUR) });
  for (const a of actions) {
    hour += a.gap;
    if (a.kind === "LIST" && sale === null) {
      list = rupees(a.price);
      push(list);
    } else if (a.kind === "SALE") {
      // a percentage off the list price, in whole rupees
      const target = ((list * (100n - a.cut)) / 100n / 100n) * 100n;
      if (salePriceProblem(list, target) === null) {
        sale = target;
        push(target);
      }
    } else if (a.kind === "END" && sale !== null) {
      sale = null;
      push(list);
    }
  }
  return { history, listPaise: list, onSale: sale !== null };
}

describe("price actions and the reference price (properties)", () => {
  it("US-43: a shown reference is above the current price and no earlier price in the 30 days before it was lower", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 12 }), (actions) => {
        const { history } = play(actions);
        const ref = referencePrice(history);
        if (ref === null) return;
        const current = history[history.length - 1] as PricePoint;
        expect(ref).toBeGreaterThan(current.pricePaise);
        let i = history.length - 1;
        while (i > 0 && (history[i - 1] as PricePoint).pricePaise === current.pricePaise) i--;
        const start = (history[i] as PricePoint).at.getTime();
        for (let k = 0; k < i; k++) {
          const a = (history[k] as PricePoint).at.getTime();
          const end = (history[k + 1] as PricePoint).at.getTime();
          if (end > a && end > start - 30 * 24 * HOUR) {
            expect((history[k] as PricePoint).pricePaise).toBeGreaterThanOrEqual(ref);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it("US-43: ending a sale restores the list price and leaves no reference", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 12 }), gapArb, (actions, gap) => {
        const before = play(actions);
        if (!before.onSale) return;
        const after = play([...actions, { kind: "END", gap }]);
        expect(after.onSale).toBe(false);
        expect((after.history[after.history.length - 1] as PricePoint).pricePaise).toBe(before.listPaise);
        expect(referencePrice(after.history)).toBeNull();
      }),
      { numRuns: 500 },
    );
  });

  it("US-43: a sale ended and started again at the same price shows no reference while the first sale is within 30 days", () => {
    // 1000 (long) -> sale 800 -> end (back to 1000) -> sale 800 again: 800 was published in the window
    expect(referencePrice([p(1000n, 0), p(800n, 100), p(1000n, 101), p(800n, 125)])).toBeNull();
    // the same restart 31 days later: the first sale has left the 30-day window
    expect(referencePrice([p(1000n, 0), p(800n, 100), p(1000n, 101), p(800n, 101 + 31 * 24)])).toBe(
      rupees(1000n),
    );
  });
});
