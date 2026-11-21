import { describe, expect, it } from "vitest";
import type { PreviewResponse } from "./api";
import { checkoutBlock, couponText, effectiveSpeeds, issueText, previewTotals } from "./cart-pricing";

const seller = (key: string, over: Partial<PreviewResponse["sellers"][number]> = {}) => ({
  sellerKey: key,
  sellerName: key,
  speed: "STANDARD" as const,
  speedsOffered: ["STANDARD" as const, "EXPRESS" as const],
  productIds: ["p"],
  itemTotalPaise: "100000",
  sellerDiscountPaise: "0",
  platformDiscountPaise: "0",
  deliveryFeePaise: "0",
  totalPaise: "100000",
  ...over,
});
const preview = (over: Partial<PreviewResponse> = {}): PreviewResponse => ({
  sellers: [
    seller("A"),
    seller("B", { itemTotalPaise: "50000", deliveryFeePaise: "10000", totalPaise: "60000" }),
  ],
  totalPaise: "160000",
  balancePaise: "1000000",
  balanceAfterPaise: "840000",
  couponCode: null,
  couponError: null,
  issues: [],
  ...over,
});

describe("cart pricing helpers", () => {
  it("R2.2: sums sellers with BigInt, past the safe integer range", () => {
    const big = preview({
      sellers: [seller("A", { itemTotalPaise: "9007199254740993" }), seller("B", { itemTotalPaise: "1" })],
      totalPaise: "9007199254740994",
    });
    expect(previewTotals(big).items).toBe(9007199254740994n);
    expect(previewTotals(preview()).delivery).toBe(10000n);
  });
  it("names why checkout is blocked, in order", () => {
    const ok = { issueCount: 0, preview: preview(), previewError: false, loading: false };
    expect(checkoutBlock(ok)).toBeNull();
    expect(checkoutBlock({ ...ok, issueCount: 1 })?.kind).toBe("issues");
    expect(checkoutBlock({ ...ok, loading: true })?.kind).toBe("loading");
    expect(checkoutBlock({ ...ok, preview: null })?.kind).toBe("pricing");
    expect(checkoutBlock({ ...ok, preview: preview({ sellers: [], totalPaise: "0" }) })?.kind).toBe("empty");
    const short = checkoutBlock({ ...ok, preview: preview({ balanceAfterPaise: "-2500" }) });
    expect(short).toEqual({ kind: "balance", shortfall: 2500n });
  });
  it("uses the chosen speed before the priced one", () => {
    expect(effectiveSpeeds(preview(), { A: "EXPRESS" })).toEqual({ A: "EXPRESS", B: "STANDARD" });
    expect(effectiveSpeeds(null, { A: "EXPRESS" })).toEqual({});
  });
  it("speaks plainly about coupons and issues", () => {
    expect(couponText(null)).toBeUndefined();
    expect(couponText("COUPON_INVALID")).toMatch(/not valid/);
    expect(couponText("COUPON_NOT_APPLICABLE")).toMatch(/does not apply/);
    expect(issueText("SOLD_OUT")).toMatch(/Sold out/);
    expect(issueText("???")).toMatch(/cannot be bought/);
  });
});
