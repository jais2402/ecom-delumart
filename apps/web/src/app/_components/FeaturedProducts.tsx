"use client";

import { ProductGrid } from "@delulu/ui";
import { CATEGORIES } from "../../data/seed-catalog";
import type { ProductResponse } from "../_lib/api";
import { featuredAcrossPrices, toGridItem } from "../_lib/catalog";
import { usePublicCatalog } from "../_lib/use-public-catalog";
import { LoadingBlock } from "./LoadState";

/** The home page's product grid; see usePublicCatalog for why it can fill in after load. */
export function FeaturedProducts({ initial }: { initial: readonly ProductResponse[] }) {
  const { products, loading } = usePublicCatalog(initial);
  if (loading) return <LoadingBlock rows={4} label="Loading products" />;
  // `initial` is already the server's featured pick; a browser-side fetch brings the whole catalog
  const picked =
    initial.length > 0
      ? products
      : featuredAcrossPrices(
          products,
          CATEGORIES.map((c) => c.slug),
        );
  return <ProductGrid items={picked.map(toGridItem)} label="Featured products" />;
}
