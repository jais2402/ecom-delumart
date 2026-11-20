import { rupees } from "@delulu/core";
import type { ProductGridItem } from "@delulu/ui";
import { CATEGORIES, type CategorySlug, SEED_PRODUCTS, type SeedProduct } from "../../data/seed-catalog";

/** Pretend shop that sells each category's products. */
const STORE_BY_CATEGORY: Record<CategorySlug, string> = {
  "impossible-tech": "Cloud Nine Gadgetry",
  "absurd-luxury": "Velvet Rope & Co",
  "everyday-magic": "Teacup Terrace Supplies",
  "imaginary-experiences": "Train Window Tours",
  "food-fantasies": "Biscuit Tin Bazaar",
  "cosmic-collectibles": "Pocket Comet Court",
};

export function storeNameOf(product: SeedProduct): string {
  return STORE_BY_CATEGORY[product.category];
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
