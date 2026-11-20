import { rupees } from "@delulu/core";
import type { ProductGridItem } from "@delulu/ui";
import { CATEGORIES, type CategorySlug, SEED_PRODUCTS, type SeedProduct } from "../../data/seed-catalog";

/**
 * Platform seed products are always labelled as DeluluMart Originals.
 * They must never appear to come from an independent creator (PRD US-02).
 */
export const SEED_STORE_NAME = "DeluluMart Originals";

export function storeNameOf(_product: SeedProduct): string {
  return SEED_STORE_NAME;
}

export function categoryName(slug: CategorySlug): string {
  return CATEGORIES.find((category) => category.slug === slug)?.name ?? slug;
}

export function toGridItem(product: SeedProduct): ProductGridItem {
  return {
    id: product.id,
    href: `/p/${product.id}`,
    name: product.name,
    hook: product.hook,
    hue: product.templateHue,
    imageAlt: product.altText,
    pricePaise: rupees(product.priceRupees),
    storeName: storeNameOf(product),
    zapEligible: product.zapEligible,
  };
}

export function productsIn(slug: string): SeedProduct[] {
  return SEED_PRODUCTS.filter((product) => product.category === slug);
}
