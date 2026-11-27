import type { ProductResponse } from "./api";
import type { PublicCoupon } from "./merchant";
import { parsePaise } from "./money";

/**
 * What the Deals page lists (PRD R2.1), taken only from what the public catalogue and the public
 * shop coupons routes already return. Nothing is invented: a product is "on sale" only when the
 * catalogue carries a reference ("Was") price above its current price, the same field the product
 * card draws.
 */

/** Products that can be bought now and carry a real reference price above the current price. Order is kept. */
export function saleProducts(products: readonly ProductResponse[]): ProductResponse[] {
  return products.filter((p) => {
    if (!p.available || !p.referencePricePaise) return false;
    try {
      return parsePaise(p.referencePricePaise) > parsePaise(p.pricePaise);
    } catch {
      return false;
    }
  });
}

export interface DealShop {
  handle: string;
  name: string;
}

/** The distinct creator shops in the catalogue, in catalogue order, at most `max`. Platform stock has no shop page. */
export function shopsOf(products: readonly ProductResponse[], max: number): DealShop[] {
  const seen = new Map<string, DealShop>();
  for (const p of products) {
    if (seen.size >= max) break;
    if (!p.storeHandle || seen.has(p.storeHandle)) continue;
    seen.set(p.storeHandle, { handle: p.storeHandle, name: p.sellerName ?? p.storeHandle });
  }
  return [...seen.values()];
}

export interface ShopCoupon {
  shop: DealShop;
  coupon: PublicCoupon;
}

/**
 * Reads each shop's public coupons, `concurrency` at a time. A shop whose request fails simply
 * contributes none: coupons are an extra, and the page works without them.
 */
export async function loadShopCoupons(
  shops: readonly DealShop[],
  read: (handle: string) => Promise<readonly PublicCoupon[]>,
  concurrency: number,
): Promise<ShopCoupon[]> {
  const out: ShopCoupon[][] = shops.map(() => []);
  let next = 0;
  async function worker() {
    while (next < shops.length) {
      const index = next++;
      const shop = shops[index] as DealShop;
      try {
        out[index] = (await read(shop.handle)).map((coupon) => ({ shop, coupon }));
      } catch {
        out[index] = [];
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, shops.length)) }, worker));
  return out.flat();
}
