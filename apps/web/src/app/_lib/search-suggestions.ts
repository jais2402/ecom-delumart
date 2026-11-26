import type { SearchSuggestion } from "@delulu/ui";
import type { ProductResponse } from "./api";
import { SHOP_CONFIG } from "./shop-config";

/**
 * Suggestions for what the shopper has typed, from the catalogue the browser already holds: the
 * same match the search page uses (the name or hook contains the text, ignoring case), plus the
 * departments whose name contains it. Empty below the minimum length.
 */
export function suggestionsFor(
  query: string,
  products: readonly ProductResponse[],
  categories: readonly { slug: string; name: string }[],
): SearchSuggestion[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < SHOP_CONFIG.suggest.minChars) return [];
  const departments = categories
    .filter((category) => category.name.toLowerCase().includes(needle))
    .slice(0, SHOP_CONFIG.suggest.maxCategories)
    .map((category) => ({
      id: `c-${category.slug}`,
      label: category.name,
      href: `/c/${category.slug}`,
      kind: "Department",
    }));
  const matches = products
    .filter((product) => `${product.name} ${product.hook ?? ""}`.toLowerCase().includes(needle))
    .slice(0, SHOP_CONFIG.suggest.maxProducts)
    .map((product) => ({
      id: `p-${product.id}`,
      label: product.name,
      href: `/p/${product.id}`,
      kind: "Product",
    }));
  return [...departments, ...matches];
}
