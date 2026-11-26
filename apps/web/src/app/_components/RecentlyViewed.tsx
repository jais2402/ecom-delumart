"use client";

import { ProductRail } from "@delulu/ui";
import { useEffect, useMemo, useState } from "react";
import { useBlockedSellerKeys, withoutBlocked } from "../_lib/blocks-store";
import { readRecent, recordViewed } from "../_lib/recently-viewed";
import { SHOP_CONFIG } from "../_lib/shop-config";
import { useFullCatalog } from "../_lib/use-full-catalog";
import { toShopGridItem } from "./shop-items";

/** Remembers that this product page was opened, in this browser only. Draws nothing. */
export function RecentlyViewedRecorder({ productId }: { productId: string }) {
  useEffect(() => {
    recordViewed(productId);
  }, [productId]);
  return null;
}

/**
 * "Recently viewed": the products this browser opened last, newest first, read from localStorage
 * and resolved from the public catalogue (which is read whole, so no id leaves the browser).
 * Nothing is drawn when there is nothing to show; `excludeId` leaves out the page's own product.
 */
export function RecentlyViewedRail({ excludeId, className }: { excludeId?: string; className?: string }) {
  const [ids, setIds] = useState<readonly string[]>([]);
  const blocked = useBlockedSellerKeys();
  useEffect(() => {
    setIds(readRecent().filter((id) => id !== excludeId?.toLowerCase()));
  }, [excludeId]);
  const { products, ready } = useFullCatalog(ids.length > 0);
  const items = useMemo(() => {
    const byId = new Map(products.map((product) => [product.id.toLowerCase(), product]));
    const found = ids.flatMap((id) => {
      const product = byId.get(id);
      return product?.available ? [product] : [];
    });
    return withoutBlocked(found, blocked).slice(0, SHOP_CONFIG.recent.railCount).map(toShopGridItem);
  }, [ids, products, blocked]);
  if (ids.length === 0 || (ready && items.length === 0)) return null;
  return (
    <ProductRail
      title="Recently viewed"
      lead="Pick up where you left off."
      items={items}
      loading={!ready}
      {...(className ? { className } : {})}
    />
  );
}
