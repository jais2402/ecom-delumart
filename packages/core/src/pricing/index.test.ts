import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { DomainError } from "../errors/index";
import { MAX_PRICE_PAISE, MIN_PRICE_PAISE, rupees } from "../money/index";
import {
  allocateProportionally,
  type Coupon,
  type CouponDiscount,
  DEFAULT_PRICING_CONFIG,
  type LineIn,
  type Posting,
  price,
  type Quote,
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
        coupon: {
          scope: "MERCHANT",
          companyId: "a",
          discount: { kind: "FLAT", amountPaise: rupees(1_000n) },
        },
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

  it("a flat merchant coupon re-allocates value capped at the ₹100 floor to lines with room", () => {
    const priced = price(
      quote({
        lines: [line("a", rupees(100n)), line("a", rupees(10_000n))],
        coupon: {
          scope: "MERCHANT",
          companyId: "a",
          discount: { kind: "FLAT", amountPaise: rupees(1_000n) },
        },
        speedBySeller: new Map<string, Speed>([["a", "STANDARD"]]),
      }),
    );
    expect(priced.lines.map((l) => l.sellerDisc)).toEqual([0n, rupees(1_000n)]);
  });

  it("a flat platform coupon re-allocates value capped at the ₹100 floor to lines with room", () => {
    const priced = price(
      quote({
        lines: [line("a", rupees(100n)), line("b", rupees(150n)), line("c", rupees(10_000n))],
        coupon: { scope: "PLATFORM", discount: { kind: "FLAT", amountPaise: rupees(1_000n) } },
        speedBySeller: new Map<string, Speed>([
          ["a", "STANDARD"],
          ["b", "STANDARD"],
          ["c", "STANDARD"],
        ]),
      }),
    );
    // pass 1 by list price: [975, 1463, 97562] paise; line 1 has no room, so its 975 is re-split
    // across the other two by list price: [14, 961].
    expect(priced.lines.map((l) => l.platformDisc)).toEqual([0n, 1_477n, 98_523n]);
    expect(priced.mint).toBe(rupees(1_000n));
  });

  it("a flat coupon larger than all headroom brings every eligible line to ₹100", () => {
    const priced = price(
      quote({
        lines: [line("a", rupees(100n)), line("a", rupees(250n)), line("a", rupees(400n))],
        coupon: {
          scope: "MERCHANT",
          companyId: "a",
          discount: { kind: "FLAT", amountPaise: rupees(10_000n) },
        },
        speedBySeller: new Map<string, Speed>([["a", "STANDARD"]]),
        isMember: true,
      }),
    );
    expect(priced.lines.map((l) => l.listPaise - l.sellerDisc)).toEqual([
      MIN_PRICE_PAISE,
      MIN_PRICE_PAISE,
      MIN_PRICE_PAISE,
    ]);
  });

  it("US-41: rejects a merchant coupon for seed stock (companyId SEED)", () => {
    expectDomainError(
      () =>
        price(
          quote({
            lines: [line("SEED", LAKH(1n))],
            coupon: { scope: "MERCHANT", companyId: "SEED", discount: { kind: "PERCENT", percent: 10 } },
            speedBySeller: new Map<string, Speed>([["SEED", "STANDARD"]]),
          }),
        ),
      "COUPON_NOT_APPLICABLE",
    );
  });

  it("the coupon percent range comes from config", () => {
    const mk = (percent: number, cfg = DEFAULT_PRICING_CONFIG): Quote =>
      quote({
        lines: [line("a", LAKH(1n))],
        coupon: { scope: "PLATFORM", discount: { kind: "PERCENT", percent } },
        speedBySeller: new Map<string, Speed>([["a", "STANDARD"]]),
        cfg,
      });
    expect(DEFAULT_PRICING_CONFIG.couponPercentMin).toBe(1);
    expect(DEFAULT_PRICING_CONFIG.couponPercentMax).toBe(90);
    const narrow = { ...DEFAULT_PRICING_CONFIG, couponPercentMin: 5, couponPercentMax: 50 };
    expectDomainError(() => price(mk(4, narrow)), "COUPON_INVALID");
    expectDomainError(() => price(mk(51, narrow)), "COUPON_INVALID");
    expect(price(mk(50, narrow)).mint).toBe(rupees(50_000n));
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

const discountArb = fc.oneof(
  fc.integer({ min: 1, max: 90 }).map((percent): CouponDiscount => ({ kind: "PERCENT", percent })),
  fc
    .bigInt({ min: 1n, max: MAX_PRICE_PAISE })
    .map((amountPaise): CouponDiscount => ({ kind: "FLAT", amountPaise })),
);

/**
 * A coupon valid for `lines` by construction: a merchant coupon names a player seller present in the
 * cart, and any minimum spend is at most the eligible spend.
 */
function couponFor(lines: readonly LineIn[]): fc.Arbitrary<Coupon | undefined> {
  const players = [...new Set(lines.map((l) => l.sellerId).filter((s) => s !== "SEED"))];
  const scopes = players.length > 0 ? (["MERCHANT", "PLATFORM"] as const) : (["PLATFORM"] as const);
  return fc.option(
    fc
      .record({
        scope: fc.constantFrom(...scopes),
        companyId: fc.constantFrom(...(players.length > 0 ? players : ["co-1"])),
        discount: discountArb,
        minSpendPct: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
      })
      .map(({ scope, companyId, discount, minSpendPct }): Coupon => {
        const eligible = lines.filter((l) => scope === "PLATFORM" || l.sellerId === companyId);
        const spend = eligible.reduce((a, l) => a + l.listPaise, 0n);
        const min = minSpendPct === undefined ? {} : { minSpendPaise: (spend * BigInt(minSpendPct)) / 100n };
        return scope === "MERCHANT" ? { scope, companyId, discount, ...min } : { scope, discount, ...min };
      }),
    { nil: undefined },
  );
}

const quoteArb: fc.Arbitrary<Quote> = fc
  .array(lineArb, { minLength: 1, maxLength: 6 })
  .chain((lines) =>
    fc.record({
      lines: fc.constant(lines),
      coupon: couponFor(lines),
      speeds: fc.array(fc.constantFrom(...SPEEDS), { minLength: SELLERS.length, maxLength: SELLERS.length }),
      isMember: fc.boolean(),
    }),
  )
  .map(({ lines, coupon, speeds, isMember }) => ({
    lines,
    ...(coupon ? { coupon } : {}),
    speedBySeller: new Map<string, Speed>(SELLERS.map((s, i) => [s, speeds[i] ?? "STANDARD"])),
    isMember,
    cfg: DEFAULT_PRICING_CONFIG,
  }));

/**
 * The only rejection a by-construction valid quote can still meet: merchant-funded free Standard
 * delivery that exceeds the seller's proceeds on a cheap order.
 */
const EXPECTED_REJECTIONS = new Set(["DELIVERY_UNAVAILABLE"]);
const stats = { accepted: 0, rejected: 0 };

/** Price the quote; a rejection must be a DomainError with an expected code and is counted. */
function tryPrice(q: Quote) {
  try {
    const priced = price(q);
    stats.accepted++;
    return priced;
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect(EXPECTED_REJECTIONS.has((e as DomainError).code), (e as DomainError).code).toBe(true);
    stats.rejected++;
    return undefined;
  }
}

describe("pricing properties", () => {
  afterAll(() => {
    // Guard against vacuous properties: nearly every generated quote must actually be priced.
    const total = stats.accepted + stats.rejected;
    expect(total).toBeGreaterThan(0);
    expect(stats.accepted / total).toBeGreaterThanOrEqual(0.95);
  });

  it("generated quotes are overwhelmingly valid (at least 95% priced)", () => {
    let accepted = 0;
    const samples = fc.sample(quoteArb, { numRuns: 500, seed: 42 });
    for (const q of samples) if (tryPrice(q)) accepted++;
    expect(accepted / samples.length).toBeGreaterThanOrEqual(0.95);
  });

  it("a flat coupon discounts min(coupon value, total headroom above ₹100 on eligible lines)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            sellerId: fc.constantFrom("co-1", "co-2"),
            listPaise: fc.oneof(
              fc.bigInt({ min: 100n, max: 2_000n }).map(rupees),
              fc.bigInt({ min: 100n, max: 1_000_000n }).map(rupees),
            ),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.bigInt({ min: 1n, max: rupees(2_000_000n) }),
        fc.constantFrom("MERCHANT" as const, "PLATFORM" as const),
        (raw, amountPaise, scope) => {
          const lines: LineIn[] = raw.map((r, i) => ({ productId: `p${i}`, ...r, freeStdDelivery: false }));
          const companyId = lines[0]?.sellerId ?? "co-1";
          const coupon: Coupon =
            scope === "MERCHANT"
              ? { scope, companyId, discount: { kind: "FLAT", amountPaise } }
              : { scope, discount: { kind: "FLAT", amountPaise } };
          const priced = price(
            quote({
              lines,
              coupon,
              speedBySeller: new Map<string, Speed>([
                ["co-1", "STANDARD"],
                ["co-2", "STANDARD"],
              ]),
              isMember: true,
            }),
          );
          const eligible = lines.filter((l) => scope === "PLATFORM" || l.sellerId === companyId);
          const headroom = eligible.reduce((a, l) => a + (l.listPaise - MIN_PRICE_PAISE), 0n);
          const given = priced.lines.reduce((a, l) => a + l.sellerDisc + l.platformDisc, 0n);
          // bigint: min(coupon value, headroom)
          if (amountPaise <= headroom) expect(given).toBe(amountPaise);
          else expect(given).toBe(headroom);
          for (const l of priced.lines) {
            expect(l.listPaise - l.sellerDisc - l.platformDisc).toBeGreaterThanOrEqual(MIN_PRICE_PAISE);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

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
              coupon: {
                scope: "MERCHANT",
                companyId: "co-1",
                discount: { kind: "FLAT", amountPaise: amount },
              },
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
