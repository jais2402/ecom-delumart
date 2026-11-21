import type { ProductGridItem, StockState } from "@delulu/ui";
import { CATEGORIES } from "../../data/seed-catalog";
import type { ProductResponse } from "./api";
import { parsePaise } from "./money";

/**
 * Platform seed products are always labelled as DeluluMart Originals.
 * They must never appear to come from an independent creator (PRD US-02).
 */
export const SEED_STORE_NAME = "DeluluMart Originals";

export function storeNameOf(product: ProductResponse): string {
  return product.sellerName ?? SEED_STORE_NAME;
}

/** The seller key a checkout quote needs: "SEED" for platform stock, the company id for a creator shop. */
export function checkoutSellerId(product: ProductResponse): string | null {
  if (product.sellerKey) return product.sellerKey;
  return storeNameOf(product) === SEED_STORE_NAME ? "SEED" : null;
}

/** The stock state a card or product page shows: sold out, an exclusive's "#issued of supply", or in stock. */
export function stockStateOf(product: ProductResponse): StockState {
  if (!product.available || product.stockBand === "SOLD_OUT") return { state: "sold-out" };
  if (product.inventoryMode === "EXCLUSIVE" && product.edition) {
    return { state: "edition", number: product.edition.issued, of: product.edition.supply };
  }
  return { state: "in-stock" };
}

/** Exclusive editions know exactly how many are left; for the rest the API only says "low". */
export function leftCount(product: ProductResponse): number | null {
  if (product.edition) return Math.max(product.edition.supply - product.edition.issued, 0);
  return null;
}

export function isLow(product: ProductResponse): boolean {
  return product.available && product.stockBand === "LOW";
}

export function categoryName(slug: string): string {
  return CATEGORIES.find((category) => category.slug === slug)?.name ?? slug;
}

export function toGridItem(product: ProductResponse): ProductGridItem {
  return {
    id: product.id,
    href: `/p/${product.id}`,
    name: product.name,
    hook: product.hook ?? "",
    hue: product.templateId,
    imageAlt: product.altText,
    pricePaise: parsePaise(product.pricePaise),
    storeName: storeNameOf(product),
    zapEligible: product.zap,
    stock: stockStateOf(product),
  };
}

const priceOf = (p: ProductResponse) => parsePaise(p.pricePaise);
const byPrice = (a: ProductResponse, b: ProductResponse) => {
  const x = priceOf(a);
  const y = priceOf(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Two products per category: one from the lower quarter and one from the upper quarter of that
 * category's prices, so the grid shows a spread rather than the cheapest items. Cheapest first.
 */
export function featuredAcrossPrices(
  products: readonly ProductResponse[],
  categorySlugs: readonly string[],
): ProductResponse[] {
  return categorySlugs
    .flatMap((slug) => {
      const sorted = products.filter((product) => product.category === slug).sort(byPrice);
      const picks = [sorted[Math.floor(sorted.length * 0.25)], sorted[Math.floor(sorted.length * 0.8)]];
      return picks.filter((product): product is ProductResponse => product !== undefined);
    })
    .sort(byPrice);
}
