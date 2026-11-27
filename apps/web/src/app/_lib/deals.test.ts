import { describe, expect, it } from "vitest";
import type { ProductResponse } from "./api";
import { loadShopCoupons, saleProducts, shopsOf } from "./deals";
import type { PublicCoupon } from "./merchant";

const product = (over: Partial<ProductResponse>): ProductResponse => ({
  id: "p",
  name: "Thing",
  hook: null,
  description: "",
  altText: "",
  pricePaise: "100000",
  category: "impossible-tech",
  templateId: 1,
  sellerName: null,
  available: true,
  zap: false,
  ...over,
});

const coupon = (code: string): PublicCoupon => ({
  code,
  kind: "PERCENT",
  percent: 10,
  amountPaise: null,
  minSpendPaise: "0",
  startsAt: null,
  endsAt: null,
  maxRedemptions: null,
});

describe("saleProducts (PRD R2.1 Deals)", () => {
  it("lists only available products whose reference price is above the current price", () => {
    const list = saleProducts([
      product({ id: "a", pricePaise: "90000", referencePricePaise: "100000" }),
      product({ id: "b", pricePaise: "90000", referencePricePaise: null }),
      product({ id: "c", pricePaise: "90000" }),
      product({ id: "d", pricePaise: "100000", referencePricePaise: "100000" }),
      product({ id: "e", pricePaise: "100000", referencePricePaise: "90000" }),
      product({ id: "f", pricePaise: "90000", referencePricePaise: "100000", available: false }),
    ]);
    expect(list.map((p) => p.id)).toEqual(["a"]);
  });
  it("compares exact bigint paise, beyond what a double holds", () => {
    const list = saleProducts([
      product({ id: "a", pricePaise: "90000000000000000", referencePricePaise: "90000000000000001" }),
    ]);
    expect(list).toHaveLength(1);
  });
  it("skips a product with an unreadable price instead of failing", () => {
    expect(saleProducts([product({ pricePaise: "x", referencePricePaise: "5" })])).toEqual([]);
  });
});

describe("shopsOf", () => {
  it("lists each creator shop once, in catalogue order, never platform stock, up to the cap", () => {
    const shops = shopsOf(
      [
        product({ id: "1", storeHandle: "zed", sellerName: "Zed" }),
        product({ id: "2", storeHandle: null }),
        product({ id: "3", storeHandle: "zed", sellerName: "Zed" }),
        product({ id: "4", storeHandle: "amy", sellerName: "Amy" }),
        product({ id: "5", storeHandle: "bob", sellerName: "Bob" }),
      ],
      2,
    );
    expect(shops).toEqual([
      { handle: "zed", name: "Zed" },
      { handle: "amy", name: "Amy" },
    ]);
  });
});

describe("loadShopCoupons", () => {
  const shops = [
    { handle: "a", name: "A" },
    { handle: "b", name: "B" },
    { handle: "c", name: "C" },
  ];
  it("gathers every shop's coupons in shop order and never exceeds the concurrency", async () => {
    let running = 0;
    let peak = 0;
    const read = async (handle: string) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return [coupon(`${handle.toUpperCase()}10`)];
    };
    const all = await loadShopCoupons(shops, read, 2);
    expect(all.map((x) => x.coupon.code)).toEqual(["A10", "B10", "C10"]);
    expect(peak).toBeLessThanOrEqual(2);
  });
  it("lets a failing shop contribute nothing", async () => {
    const read = async (handle: string) => {
      if (handle === "b") throw new Error("down");
      return [coupon(handle)];
    };
    const all = await loadShopCoupons(shops, read, 3);
    expect(all.map((x) => x.shop.handle)).toEqual(["a", "c"]);
  });
  it("returns nothing for no shops", async () => {
    expect(await loadShopCoupons([], async () => [], 4)).toEqual([]);
  });
});
