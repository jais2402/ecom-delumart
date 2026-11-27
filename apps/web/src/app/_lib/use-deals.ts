"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type ProductResponse } from "./api";
import { type DealShop, loadShopCoupons, type ShopCoupon, saleProducts, shopsOf } from "./deals";
import type { PublicCoupon } from "./merchant";
import { SHOP_CONFIG } from "./shop-config";
import { loadFullCatalog } from "./use-full-catalog";

export type DealsState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      sale: ProductResponse[];
      coupons: ShopCoupon[];
      couponsReady: boolean;
      shops: DealShop[];
    };

/**
 * The Deals page's data, read in the browser from routes that are already public: the catalogue
 * (the same read the search page uses) and each shop's public coupons (the read the shop page
 * uses). No new route. Coupons arrive after the products and never block them.
 */
export function useDeals(): { state: DealsState; reload: () => void } {
  const [state, setState] = useState<DealsState>({ status: "loading" });
  const [round, setRound] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` re-runs the read when "Try again" is pressed
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      const all = await loadFullCatalog();
      const shops = shopsOf(all, SHOP_CONFIG.deals.maxShops);
      const sale = saleProducts(all);
      if (!cancelled) setState({ status: "ready", sale, coupons: [], couponsReady: false, shops });
      const coupons = await loadShopCoupons(
        shops,
        async (handle) => (await api<{ items: PublicCoupon[] }>(`/api/v1/stores/${handle}/coupons`)).items,
        SHOP_CONFIG.deals.concurrency,
      );
      if (!cancelled) setState({ status: "ready", sale, coupons, couponsReady: true, shops });
    })().catch(() => {
      if (!cancelled) setState({ status: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { state, reload };
}
