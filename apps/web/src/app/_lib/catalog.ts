import type { ProductGridItem } from "@delulu/ui";
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

/** The seller key a checkout quote needs. The catalog exposes no id for creator shops (API gap). */
export function checkoutSellerId(product: ProductResponse): "SEED" | null {
  return storeNameOf(product) === SEED_STORE_NAME ? "SEED" : null;
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
    stock: product.available ? { state: "in-stock" } : { state: "sold-out" },
  };
}
