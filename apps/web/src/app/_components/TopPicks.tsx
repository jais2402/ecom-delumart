"use client";

import { ProductRail } from "@delulu/ui";
import { useMemo, useState } from "react";
import { useBlockedSellerKeys, withoutBlocked } from "../_lib/blocks-store";
import { TOP_PICKS_ALL, type TopPicksTab } from "../_lib/home-rails";
import { toShopGridItem } from "./shop-items";

/**
 * "Top picks": one rail whose tabs ("All" and the categories) switch between lists the page already
 * has. Nothing is fetched and the address does not change; "View all" appears for a category tab,
 * where a page lists that category. Products of shops the viewer blocked are left out.
 */
export function TopPicks({ tabs: initial }: { tabs: readonly TopPicksTab[] }) {
  const blocked = useBlockedSellerKeys();
  const [chosen, setChosen] = useState(TOP_PICKS_ALL);
  const tabs = useMemo(
    () =>
      initial
        .map((tab) => ({ ...tab, products: withoutBlocked(tab.products, blocked) }))
        .filter((tab) => tab.products.length > 0),
    [initial, blocked],
  );
  const tab = tabs.find((candidate) => candidate.key === chosen) ?? tabs[0];
  const items = useMemo(() => tab?.products.map(toShopGridItem) ?? [], [tab]);
  if (!tab) return null;
  return (
    <ProductRail
      id="top-picks"
      title="Top picks."
      lead="Across the whole range."
      items={items}
      {...(tab.href ? { seeAll: { href: tab.href, label: "View all" } } : {})}
      filters={{
        label: "Filter top picks by category",
        options: tabs.map(({ key, label }) => ({ key, label })),
        value: tab.key,
        onChange: setChosen,
      }}
    />
  );
}
