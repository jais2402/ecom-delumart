import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/index";
import { MAX_PRICE_PAISE, MIN_PRICE_PAISE, rupees } from "../money/index";
import {
  allocateProportionally,
  type Coupon,
  DEFAULT_PRICING_CONFIG,
  type LineIn,
  type Posting,
  type Quote,
  price,
  type Speed,
} from "./index";

const CRORE = (n: bigint) => rupees(n * 10_000_000n);
const LAKH = (n: bigint) => rupees(n * 100_000n);

function postingMap(postings: readonly Posting[]): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const p of postings) out[p.account] = p.amountPaise;
  return out;
}

function quote(partial: Partial<Quote> & Pick<Quote, "lines">): Quote {
  return {
    speedBySeller: new Map<string, Speed>(),
    isMember: false,
    cfg: DEFAULT_PRICING_CONFIG,
    ...partial,
  };
}

function expectDomainError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}`);
}

describe("pricing worked examples", () => {
  it("US-41 (a): ₹2 crore item, 10% merchant coupon, Standard delivery", () => {
    const priced = price(
      quote({
        lines: [{ productId: "p1", sellerId: "co-1", listPaise: CRORE(2n), freeStdDelivery: false }],
        coupon: { scope: "MERCHANT", companyId: "co-1", discount: { kind: "PERCENT", percent: 10 } },
        speedBySeller: new Map([["co-1", "STANDARD"]]),
      }),
    );
    expect(postingMap(priced.postings)).toEqual({
      BUYER: -rupees(1_80_01_000n),
      "co-1": rupees(1_71_00_000n),
      SINK: rupees(9_01_000n),
    });
    expect(priced.buyerTotal).toBe(rupees(1_80_01_000n));
    expect(priced.mint).toBe(0n);
    expect(priced.sink).toBe(rupees(9_01_000n));
  });

  it("US-42 (b): ₹2 crore item, ₹10 lakh platform coupon, member with free Standard delivery", () => {
    const priced = price(
      quote({
        lines: [{ productId: "p1", sellerId: "co-1", listPaise: CRORE(2n), freeStdDelivery: false }],
        coupon: { scope: "PLATFORM", discount: { kind: "FLAT", amountPaise: LAKH(10n) } },
        speedBySeller: new Map([["co-1", "STANDARD"]]),
        isMember: true,
      }),
    );
    expect(postingMap(priced.postings)).toEqual({
      BUYER: -rupees(1_90_00_000n),
      MINT: -LAKH(10n),
      "co-1": rupees(1_90_00_000n),
      SINK: LAKH(10n),
    });
    expect(priced.mint).toBe(LAKH(10n));
  });

  it("(c): merchant-funded free Standard delivery on a ₹1 lakh item", () => {
    const priced = price(
      quote({
        lines: [{ productId: "p1", sellerId: "co-1", listPaise: LAKH(1n), freeStdDelivery: true }],
        speedBySeller: new Map([["co-1", "STANDARD"]]),
      }),
    );
    expect(postingMap(priced.postings)).toEqual({
      BUYER: -LAKH(1n),
      "co-1": rupees(94_000n),
      SINK: rupees(6_000n),
    });
    const seller = priced.perSeller[0];
    expect(seller?.deliveryBuyer).toBe(0n);
    expect(seller?.deliverySeller).toBe(rupees(1_000n));
  });

  it("(d): ₹20 crore seed item, Standard delivery", () => {
    const priced = price(
      quote({
        lines: [{ productId: "s1", sellerId: "SEED", listPaise: CRORE(20n), freeStdDelivery: false }],
        speedBySeller: new Map([["SEED", "STANDARD"]]),
      }),
    );
    expect(postingMap(priced.postings)).toEqual({
      BUYER: -(CRORE(20n) + rupees(1_000n)),
      SINK: CRORE(20n) + rupees(1_000n),
    });
    expect(priced.perSeller[0]?.fee).toBe(0n);
  });
});

describe("pricing rules", () => {
  const line = (sellerId: string, list: bigint, free = false): LineIn => ({
    productId: `p-${sellerId}-${list}`,
    sellerId,
    listPaise: list,
    freeStdDelivery: free,
  });

  it("Express is free and Zap is half price for members", () => {
    const priced = price(
      quote({
        lines: [line("a", LAKH(1n)), line("b", LAKH(1n))],
        speedBySeller: new Map<string, Speed>([
          ["a", "EXPRESS"],
          ["b", "ZAP"],
        ]),
        isMember: true,
      }),
    );
    expect(priced.perSeller.map((s) => s.deliveryBuyer)).toEqual([0n, rupees(25_000n)]);
  });

  it("delivery fees come from config", () => {
    const priced = price(
      quote({
        lines: [line("a", LAKH(1n))],
        speedBySeller: new Map<string, Speed>([["a", "ZAP"]]),
        cfg: { ...DEFAULT_PRICING_CONFIG, deliveryFeePaise: { STANDARD: 1n, EXPRESS: 2n, ZAP: 3n } },
      }),
    );
    expect(priced.perSeller[0]?.deliveryBuyer).toBe(3n);
  });

  it("merchant-funded free delivery applies only when every line of the seller offers it", () => {
    const priced = price(
      quote({
        lines: [line("a", LAKH(1n), true), line("a", LAKH(2n), false)],
        speedBySeller: new Map<string, Speed>([["a", "STANDARD"]]),
      }),
    );
    expect(priced.perSeller[0]?.deliveryBuyer).toBe(rupees(1_000n));
    expect(priced.perSeller[0]?.deliverySeller).toBe(0n);
  });

  it("merchant-funded free delivery does not apply to Express", () => {
    const priced = price(
      quote({
        lines: [line("a", LAKH(1n), true)],
        speedBySeller: new Map<string, Speed>([["a", "EXPRESS"]]),
      }),
    );
    expect(priced.perSeller[0]?.deliveryBuyer).toBe(rupees(10_000n));
  });

  it("discount is capped so the discounted line price stays at least ₹100", () => {
    const priced = price(
      quote({
        lines: [line("a", rupees(150n))],
        coupon: { scope: "MERCHANT", companyId: "a", discount: { kind: "FLAT", amountPaise: rupees(1_000n) } },
        speedBySeller: new Map<string, Speed>([["a", "STANDARD"]]),
        isMember: true,
      }),
    );
    expect(priced.lines[0]?.sellerDisc).toBe(rupees(50n));
    expect(priced.buyerTotal).toBe(MIN_PRICE_PAISE);
  });

  it("platform discount is also capped at the ₹100 floor", () => {
    const priced = price(
      quote({
        lines: [line("a", rupees(500n))],
        coupon: { scope: "PLATFORM", discount: { kind: "PERCENT", percent: 90 } },
        speedBySeller: new Map<string, Speed>([["a", "STANDARD"]]),
        isMember: true,
      }),
    );
    expect(priced.lines[0]?.platformDisc).toBe(rupees(400n));
    expect(priced.buyerTotal).toBe(MIN_PRICE_PAISE);
  });

  it("merchant coupon only discounts that company's lines", () => {
    const priced = price(
      quote({
        lines: [line("a", LAKH(1n)), line("b", LAKH(1n))],
        coupon: { scope: "MERCHANT", companyId: "a", discount: { kind: "PERCENT", percent: 10 } },
        speedBySeller: new Map<string, Speed>([
          ["a", "STANDARD"],
          ["b", "STANDARD"],
        ]),
      }),
    );
    expect(priced.lines.map((l) => l.sellerDisc)).toEqual([rupees(10_000n), 0n]);
  });

  it("US-41: rejects a merchant coupon for a company with no lines in the cart", () => {
    expectDomainError(
      () =>
        price(
          quote({
            lines: [line("b", LAKH(1n))],
            coupon: { scope: "MERCHANT", companyId: "a", discount: { kind: "PERCENT", percent: 10 } },
            speedBySeller: new Map<string, Speed>([["b", "STANDARD"]]),
          }),
        ),
      "COUPON_NOT_APPLICABLE",
    );
  });

  it("rejects a coupon whose minimum spend is unmet, accepts at exactly the minimum", () => {
    const mk = (minSpendPaise: bigint): Quote =>
      quote({
        lines: [line("a", LAKH(1n))],
        coupon: { scope: "PLATFORM", discount: { kind: "PERCENT", percent: 10 }, minSpendPaise },
        speedBySeller: new Map<string, Speed>([["a", "STANDARD"]]),
      });
    expectDomainError(() => price(mk(LAKH(1n) + 1n)), "COUPON_NOT_APPLICABLE");
    expect(price(mk(LAKH(1n))).mint).toBe(rupees(10_000n));
  });

  it("rejects an out-of-range percent coupon", () => {
    for (const percent of [0, 91, 12.5]) {
      expectDomainError(
        () =>
          price(
            quote({
              lines: [line("a", LAKH(1n))],
              coupon: { scope: "PLATFORM", discount: { kind: "PERCENT", percent } },
              speedBySeller: new Map<string, Speed>([["a", "STANDARD"]]),
            }),
          ),
        "COUPON_INVALID",
      );
    }
  });

  it("rejects a quote where merchant-funded delivery exceeds the seller's proceeds", () => {
    expectDomainError(
      () =>
        price(
          quote({
            lines: [line("a", rupees(500n), true)],
            speedBySeller: new Map<string, Speed>([["a", "STANDARD"]]),
          }),
        ),
      "DELIVERY_UNAVAILABLE",
    );
  });

  it("rejects a seller with no delivery speed and invalid list prices", () => {
    expectDomainError(() => price(quote({ lines: [line("a", LAKH(1n))] })), "VALIDATION_FAILED");
    expectDomainError(
      () =>
        price(
          quote({
            lines: [line("a", rupees(99n))],
            speedBySeller: new Map<string, Speed>([["a", "STANDARD"]]),
          }),
        ),
      "VALIDATION_FAILED",
    );
    expectDomainError(
      () =>
        price(
          quote({ lines: [line("a", 10_050n)], speedBySeller: new Map<string, Speed>([["a", "STANDARD"]]) }),
        ),
      "VALIDATION_FAILED",
    );
    expectDomainError(() => price(quote({ lines: [] })), "VALIDATION_FAILED");
  });
});

// ---------- property tests ----------

const SELLERS = ["SEED", "co-1", "co-2", "co-3"] as const;
const SPEEDS: readonly Speed[] = ["STANDARD", "EXPRESS", "ZAP"];

const listPriceArb = fc
  .bigInt({ min: MIN_PRICE_PAISE / 100n, max: MAX_PRICE_PAISE / 100n })
  .map((r) => r * 100n);

const lineArb: fc.Arbitrary<LineIn> = fc.record({
  productId: fc.uuid(),
  sellerId: fc.constantFrom(...SELLERS),
  listPaise: listPriceArb,
  freeStdDelivery: fc.boolean(),
});

const couponArb: fc.Arbitrary<Coupon | undefined> = fc.option(
  fc.record({
    scope: fc.constantFrom("MERCHANT" as const, "PLATFORM" as const),
    companyId: fc.constantFrom("co-1", "co-2", "co-3"),
    discount: fc.oneof(
      fc.integer({ min: 1, max: 90 }).map((percent) => ({ kind: "PERCENT" as const, percent })),
      fc.bigInt({ min: 1n, max: MAX_PRICE_PAISE }).map((amountPaise) => ({ kind: "FLAT" as const, amountPaise })),
    ),
    minSpendPaise: fc.option(fc.bigInt({ min: 0n, max: MAX_PRICE_PAISE }), { nil: undefined }),
  }).map(({ scope, companyId, discount, minSpendPaise }): Coupon => {
    const min = minSpendPaise === undefined ? {} : { minSpendPaise };
    return scope === "MERCHANT"
      ? { scope, companyId, discount, ...min }
      : { scope, discount, ...min };
  }),
  { nil: undefined },
);

const quoteArb: fc.Arbitrary<Quote> = fc
  .record({
    lines: fc.array(lineArb, { minLength: 1, maxLength: 6 }),
    coupon: couponArb,
    speeds: fc.array(fc.constantFrom(...SPEEDS), { minLength: SELLERS.length, maxLength: SELLERS.length }),
    isMember: fc.boolean(),
  })
  .map(({ lines, coupon, speeds, isMember }) => ({
    lines,
    ...(coupon ? { coupon } : {}),
    speedBySeller: new Map<string, Speed>(SELLERS.map((s, i) => [s, speeds[i] ?? "STANDARD"])),
    isMember,
    cfg: DEFAULT_PRICING_CONFIG,
  }));

/** Price the quote; quotes the design rejects return undefined (the rejection must be a DomainError). */
function tryPrice(q: Quote) {
  try {
    return price(q);
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return undefined;
  }
}

describe("pricing properties", () => {
  it("postings always sum to zero and buyerTotal matches the buyer debit", () => {
    fc.assert(
      fc.property(quoteArb, (q) => {
        const priced = tryPrice(q);
        if (!priced) return;
        expect(priced.postings.reduce((a, p) => a + p.amountPaise, 0n)).toBe(0n);
        expect(postingMap(priced.postings).BUYER).toBe(-priced.buyerTotal);
        expect(postingMap(priced.postings).MINT ?? 0n).toBe(-priced.mint);
        expect(postingMap(priced.postings).SINK ?? 0n).toBe(priced.sink);
      }),
      { numRuns: 500 },
    );
  });

  it("no amount is negative except the buyer and mint debits", () => {
    fc.assert(
      fc.property(quoteArb, (q) => {
        const priced = tryPrice(q);
        if (!priced) return;
        for (const p of priced.postings) {
          if (p.account === "BUYER" || p.account === "MINT") expect(p.amountPaise).toBeLessThan(0n);
          else expect(p.amountPaise).toBeGreaterThan(0n);
        }
        for (const s of priced.perSeller) expect(s.net).toBeGreaterThanOrEqual(0n);
        for (const l of priced.lines) {
          expect(l.sellerDisc).toBeGreaterThanOrEqual(0n);
          expect(l.platformDisc).toBeGreaterThanOrEqual(0n);
          expect(l.listPaise - l.sellerDisc - l.platformDisc).toBeGreaterThanOrEqual(MIN_PRICE_PAISE);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("fee is floor(5% of price after seller discount) for player lines and 0 for seed", () => {
    fc.assert(
      fc.property(quoteArb, (q) => {
        const priced = tryPrice(q);
        if (!priced) return;
        for (const l of priced.lines) {
          const expected = l.sellerId === "SEED" ? 0n : ((l.listPaise - l.sellerDisc) * 5n) / 100n;
          expect(l.fee).toBe(expected);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("flat allocation sums exactly and is proportional with floor", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 13n }), { minLength: 1, maxLength: 20 }),
        (total, weights) => {
          const parts = allocateProportionally(total, weights);
          expect(parts.length).toBe(weights.length);
          expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
          const sumW = weights.reduce((a, b) => a + b, 0n);
          for (let i = 0; i < weights.length - 1; i++) {
            expect(parts[i]).toBe((total * (weights[i] ?? 0n)) / sumW);
          }
        },
      ),
    );
  });

  it("an uncapped flat coupon discounts exactly its amount", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1_000n, max: 1_000_000n }).map(rupees), { minLength: 1, maxLength: 5 }),
        fc.bigInt({ min: 1n, max: rupees(100n) }),
        (lists, amount) => {
          const priced = price(
            quote({
              lines: lists.map((l, i) => ({
                productId: `p${i}`,
                sellerId: "co-1",
                listPaise: l,
                freeStdDelivery: false,
              })),
              coupon: { scope: "MERCHANT", companyId: "co-1", discount: { kind: "FLAT", amountPaise: amount } },
              speedBySeller: new Map<string, Speed>([["co-1", "STANDARD"]]),
            }),
          );
          expect(priced.lines.reduce((a, l) => a + l.sellerDisc, 0n)).toBe(amount);
        },
      ),
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(quoteArb, (q) => {
        const a = tryPrice(q);
        const b = tryPrice(q);
        expect(a).toEqual(b);
      }),
      { numRuns: 100 },
    );
  });
});
