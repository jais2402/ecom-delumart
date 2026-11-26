"use client";

import { ProductRail } from "@delulu/ui";
import { useMemo } from "react";
import { CATEGORIES } from "../../data/seed-catalog";
import { useBlockedSellerKeys, withoutBlocked } from "../_lib/blocks-store";
import { deriveHomeRails, deriveTopPicks, type HomeRailData, type TopPicksTab } from "../_lib/home-rails";
import { usePublicCatalog } from "../_lib/use-public-catalog";
import { toShopGridItem } from "./shop-items";
import { TopPicks } from "./TopPicks";

/**
 * The home page's product sections: "Top picks" with its category tabs, then the plain rails. The
 * server derives them from the catalogue it already read; if the page was built without products,
 * the browser reads the public catalogue instead and derives the same sections (see
 * usePublicCatalog). Products of shops the viewer blocked are left out.
 */
export function HomeRails({
  topPicks: initialTabs,
  rails: initialRails,
}: {
  topPicks: readonly TopPicksTab[];
  rails: readonly HomeRailData[];
}) {
  const seeded = initialTabs.length > 0 || initialRails.length > 0;
  // when seeded, hand the hook something non-empty so it does not fetch
  const { products, loading } = usePublicCatalog(
    seeded ? (initialTabs[0]?.products ?? initialRails[0]?.products ?? []) : [],
  );
  const blocked = useBlockedSellerKeys();
  const tabs = useMemo(
    () => (seeded ? initialTabs : deriveTopPicks(products, CATEGORIES)),
    [seeded, initialTabs, products],
  );
  const rails = useMemo(() => {
    const source = seeded ? initialRails : deriveHomeRails(products);
    return source
      .map((rail) => ({ ...rail, products: withoutBlocked(rail.products, blocked) }))
      .filter((rail) => rail.products.length > 0);
  }, [seeded, initialRails, products, blocked]);

  if (loading) {
    return (
      <>
        <ProductRail title="Top picks." items={[]} loading />
        <ProductRail title="Lowest prices." items={[]} loading />
      </>
    );
  }
  if (tabs.length === 0 && rails.length === 0) {
    return (
      <ProductRail
        title="Top picks."
        items={[]}
        emptyText="The shelves are being restocked. Check back soon."
      />
    );
  }
  return (
    <>
      <TopPicks tabs={tabs} />
      {rails.map((rail) => (
        <ProductRail
          key={rail.key}
          title={rail.title}
          {...(rail.lead ? { lead: rail.lead } : {})}
          items={rail.products.map(toShopGridItem)}
        />
      ))}
    </>
  );
}
