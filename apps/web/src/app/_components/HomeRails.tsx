"use client";

import { ProductRail } from "@delulu/ui";
import { useMemo } from "react";
import { CATEGORIES } from "../../data/seed-catalog";
import { useBlockedSellerKeys, withoutBlocked } from "../_lib/blocks-store";
import { deriveHomeRails, type HomeRailData } from "../_lib/home-rails";
import { usePublicCatalog } from "../_lib/use-public-catalog";
import { toShopGridItem } from "./shop-items";

/**
 * The home page's product rails. The server derives them from the catalogue it already read; if
 * the page was built without products, the browser reads the public catalogue instead and derives
 * the same rails (see usePublicCatalog). Products of shops the viewer blocked are left out.
 */
export function HomeRails({ rails: initial }: { rails: readonly HomeRailData[] }) {
  const { products, loading } = usePublicCatalog(initial[0]?.products ?? []);
  const blocked = useBlockedSellerKeys();
  const rails = useMemo(() => {
    const source = initial.length > 0 ? initial : deriveHomeRails(products, CATEGORIES);
    return source
      .map((rail) => ({ ...rail, products: withoutBlocked(rail.products, blocked) }))
      .filter((rail) => rail.products.length > 0);
  }, [initial, products, blocked]);

  if (loading) {
    return (
      <>
        <ProductRail title="New arrivals." items={[]} loading />
        <ProductRail title="Lowest prices." items={[]} loading />
      </>
    );
  }
  if (rails.length === 0) {
    return (
      <ProductRail
        title="New arrivals."
        items={[]}
        emptyText="The shelves are being restocked. Check back soon."
      />
    );
  }
  return (
    <>
      {rails.map((rail) => (
        <ProductRail
          key={rail.key}
          title={rail.title}
          {...(rail.lead ? { lead: rail.lead } : {})}
          {...(rail.category ? { seeAll: { href: `/c/${rail.category}`, label: "See all" } } : {})}
          items={rail.products.map(toShopGridItem)}
        />
      ))}
    </>
  );
}
