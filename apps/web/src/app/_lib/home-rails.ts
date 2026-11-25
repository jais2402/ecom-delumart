import type { ProductResponse } from "./api";
import { featuredAcrossPrices } from "./catalog";
import { HOME_CONFIG } from "./home-config";
import { parsePaise } from "./money";

export interface HomeRailData {
  /** Stable key for the rail. */
  key: string;
  title: string;
  /** A grey sentence after the title. */
  lead?: string;
  /** Category slug when the rail is one category's. */
  category?: string;
  products: readonly ProductResponse[];
}

/** Money compared as bigint paise only (invariant 1). */
const byPriceAscending = (a: ProductResponse, b: ProductResponse): number => {
  const x = parsePaise(a.pricePaise);
  const y = parsePaise(b.pricePaise);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * The home page's rails, derived only from the catalogue the page already has: the spread across
 * prices ("New arrivals"), the cheapest, the dearest, then one rail per category with
 * enough products. A rail with nothing in it is left out.
 */
export function deriveHomeRails(
  products: readonly ProductResponse[],
  categories: readonly { slug: string; name: string }[],
): HomeRailData[] {
  const { pocketChangeCount, bigFlexCount, categoryRailCount, categoryRailMinimum } = HOME_CONFIG.rails;
  const available = products.filter((product) => product.available);
  const sorted = [...available].sort(byPriceAscending);
  const rails: HomeRailData[] = [
    {
      key: "fresh",
      title: "New arrivals.",
      lead: "The latest additions.",
      products: featuredAcrossPrices(
        available,
        categories.map((c) => c.slug),
      ),
    },
    {
      key: "pocket-change",
      title: "Lowest prices.",
      lead: "Start small.",
      products: sorted.slice(0, pocketChangeCount),
    },
    {
      key: "big-flex",
      title: "Premium picks.",
      lead: "The top of the range.",
      products: sorted.slice(-bigFlexCount).reverse(),
    },
  ];
  for (const category of categories) {
    const inCategory = available.filter((product) => product.category === category.slug);
    if (inCategory.length >= categoryRailMinimum) {
      rails.push({
        key: `category-${category.slug}`,
        title: `${category.name}.`,
        category: category.slug,
        products: inCategory.slice(0, categoryRailCount),
      });
    }
  }
  return rails.filter((rail) => rail.products.length > 0);
}

/** The first available product of a category, which stands for it in pictures. */
export function representativeOf(
  products: readonly ProductResponse[],
  slug: string,
): ProductResponse | undefined {
  return products.find((product) => product.available && product.category === slug);
}

/** The lowest price in a category, in paise (bigint comparison only), or undefined when it has no products. */
export function lowestPriceOf(products: readonly ProductResponse[], slug: string): bigint | undefined {
  let lowest: bigint | undefined;
  for (const product of products) {
    if (!product.available || product.category !== slug) continue;
    const price = parsePaise(product.pricePaise);
    if (lowest === undefined || price < lowest) lowest = price;
  }
  return lowest;
}
