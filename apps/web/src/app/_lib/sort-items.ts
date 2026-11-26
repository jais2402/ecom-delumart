import type { ProductGridItem } from "@delulu/ui";

export type SortKey = "match" | "price-asc" | "price-desc" | "name";

export const SORT_OPTIONS: readonly { key: SortKey; label: string }[] = [
  { key: "match", label: "Best match" },
  { key: "price-asc", label: "Price low to high" },
  { key: "price-desc", label: "Price high to low" },
  { key: "name", label: "Name A to Z" },
];

export function isSortKey(value: string): value is SortKey {
  return SORT_OPTIONS.some((option) => option.key === value);
}

const byPrice = (a: ProductGridItem, b: ProductGridItem): number =>
  a.pricePaise < b.pricePaise ? -1 : a.pricePaise > b.pricePaise ? 1 : 0;

/**
 * Orders the products already on the page. "Best match" keeps the order given (the catalogue's own
 * for a category, the order of the matches for a search). Prices are compared as bigint paise, never
 * as numbers; ties keep their order because the sort is stable.
 */
export function sortItems(items: readonly ProductGridItem[], key: SortKey): ProductGridItem[] {
  const copy = [...items];
  if (key === "price-asc") return copy.sort(byPrice);
  if (key === "price-desc") return copy.sort((a, b) => byPrice(b, a));
  if (key === "name") return copy.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  return copy;
}
