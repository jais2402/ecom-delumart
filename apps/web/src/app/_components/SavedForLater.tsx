"use client";

import { ProductRail } from "@delulu/ui";
import { useEffect, useMemo, useState } from "react";
import { api } from "../_lib/api";
import { useBlockedSellerKeys, withoutBlocked } from "../_lib/blocks-store";
import type { SavedPage } from "../_lib/selling";
import { useSession } from "../_lib/session-store";
import { SHOP_CONFIG } from "../_lib/shop-config";
import { useFullCatalog } from "../_lib/use-full-catalog";
import { toShopGridItem } from "./shop-items";

/**
 * "Saved for later" on the home page, for signed-in shoppers only: the newest saved products, read
 * in the browser from the private saves route the account's Saved page uses, and shown with the
 * public catalogue's details. It is fetched after sign-in is known and never part of a public
 * response. Nothing is drawn when nothing is saved.
 */
export function SavedForLaterRail() {
  const session = useSession();
  const signedIn = session.status === "signedIn";
  const [ids, setIds] = useState<readonly string[]>([]);
  const blocked = useBlockedSellerKeys();
  useEffect(() => {
    if (!signedIn) {
      setIds([]);
      return;
    }
    let cancelled = false;
    api<SavedPage>(`/api/v1/saves?limit=${SHOP_CONFIG.saved.railCount}`)
      .then((page) => {
        if (!cancelled) setIds(page.items.filter((item) => item.published).map((item) => item.productId));
      })
      .catch(() => {
        // a convenience: the Saved page shows any error
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);
  const { products } = useFullCatalog(ids.length > 0);
  const items = useMemo(() => {
    const byId = new Map(products.map((product) => [product.id.toLowerCase(), product]));
    const found = ids.flatMap((id) => {
      const product = byId.get(id.toLowerCase());
      return product?.available ? [product] : [];
    });
    return withoutBlocked(found, blocked).map(toShopGridItem);
  }, [ids, products, blocked]);
  if (!signedIn || items.length === 0) return null;
  return (
    <ProductRail
      title="Saved for later"
      lead="Products you hearted, ready when you are."
      items={items}
      seeAll={{ href: "/account/saved", label: "View all" }}
    />
  );
}
