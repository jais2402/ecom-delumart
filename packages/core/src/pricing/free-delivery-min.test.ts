import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/index";
import { MAX_PRICE_PAISE, MIN_PRICE_PAISE, PAISE_PER_RUPEE } from "../money/index";
import { DEFAULT_PRICING_CONFIG, minPriceForFreeDelivery, type PricingConfig, price } from "./index";

/** R6.5: merchant-funded free Standard delivery needs a price that can fund the fee. */
describe("minPriceForFreeDelivery", () => {
  const free = (listPaise: bigint, cfg: PricingConfig = DEFAULT_PRICING_CONFIG) =>
    price({
      lines: [{ productId: "p", sellerId: "co", listPaise, freeStdDelivery: true }],
      speedBySeller: new Map([["co", "STANDARD" as const]]),
      isMember: false,
      cfg,
    });

  it("US-40: with the default 5% fee and ₹1,000 Standard fee the minimum is ₹1,053", () => {
    expect(minPriceForFreeDelivery(DEFAULT_PRICING_CONFIG)).toBe(105_300n);
    expect(() => free(105_300n)).not.toThrow();
    expect(() => free(105_200n)).toThrow(DomainError);
  });

  it("US-40: property: the minimum is exactly the lowest whole-rupee price the pricing function accepts", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.bigInt({ min: 0n, max: 200_000n }),
        (feePercent, standardPaise) => {
          const cfg: PricingConfig = {
            ...DEFAULT_PRICING_CONFIG,
            feePercent,
            deliveryFeePaise: { ...DEFAULT_PRICING_CONFIG.deliveryFeePaise, STANDARD: standardPaise },
          };
          const min = minPriceForFreeDelivery(cfg);
          expect(min).not.toBeNull();
          if (min === null || min > MAX_PRICE_PAISE) return;
          expect(() => free(min, cfg)).not.toThrow();
          if (min - PAISE_PER_RUPEE >= MIN_PRICE_PAISE) {
            expect(() => free(min - PAISE_PER_RUPEE, cfg)).toThrow(DomainError);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it("a 100% fee can never fund it", () => {
    expect(minPriceForFreeDelivery({ ...DEFAULT_PRICING_CONFIG, feePercent: 100 })).toBeNull();
  });
});
