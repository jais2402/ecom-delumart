import type { ProductResponse } from "./api";
import { featuredAcrossPrices } from "./catalog";
import { HOME_CONFIG } from "./home-config";
import { parsePaise } from "./money";
import { photoSrcOf } from "./product-photos";

export interface HomeRailData {
  /** Stable key for the rail. */
  key: string;
  title: string;
  /** A grey sentence after the title. */
  lead?: string;
  products: readonly ProductResponse[];
}

/** Money compared as bigint paise only (invariant 1). */
const byPriceAscending = (a: ProductResponse, b: ProductResponse): number => {
  const x = parsePaise(a.pricePaise);
  const y = parsePaise(b.pricePaise);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Seed products with a photo come first so the large hero panels are pictures where possible; the order within each group is kept. */
function photosFirst(products: readonly ProductResponse[]): ProductResponse[] {
  return [
    ...products.filter((product) => photoSrcOf(product) !== undefined),
    ...products.filter((product) => photoSrcOf(product) === undefined),
  ];
}

/**
 * The hero's featured products: the dearest available ones, those with a photo first, as many as
 * the configuration says. Deterministic for a given catalogue; money compared as bigint paise.
 */
export function pickHeroProducts(products: readonly ProductResponse[]): ProductResponse[] {
  const dearest = products.filter((product) => product.available).sort((a, b) => byPriceAscending(b, a));
  return photosFirst(dearest).slice(0, HOME_CONFIG.hero.slideCount);
}

export interface TopPicksTab {
  /** "all" or the category slug. */
  key: string;
  label: string;
  /** Where "View all" goes: the category's page. "All" has none, because no page lists the whole catalogue. */
  href?: string;
  products: readonly ProductResponse[];
}

/** The key of the first tab, which shows every category. */
export const TOP_PICKS_ALL = "all";

/**
 * The "Top picks" tabs, from the catalogue the page already has: "All" is the spread across prices
 * (two per category, cheapest first), then one tab per category that has available products, in the
 * catalogue's own order, capped by configuration. Nothing here is a popularity ranking.
 */
export function deriveTopPicks(
  products: readonly ProductResponse[],
  categories: readonly { slug: string; name: string }[],
): TopPicksTab[] {
  const available = products.filter((product) => product.available);
  const all = featuredAcrossPrices(
    available,
    categories.map((c) => c.slug),
  ).slice(0, HOME_CONFIG.topPicks.perTab);
  if (all.length === 0) return [];
  const tabs: TopPicksTab[] = [{ key: TOP_PICKS_ALL, label: "All", products: all }];
  for (const category of categories) {
    const inCategory = available.filter((product) => product.category === category.slug);
    if (inCategory.length > 0) {
      tabs.push({
        key: category.slug,
        label: category.name,
        href: `/c/${category.slug}`,
        products: inCategory.slice(0, HOME_CONFIG.topPicks.perTab),
      });
    }
  }
  return tabs;
}

/**
 * The home page's plain rails, derived only from the catalogue the page already has: the cheapest,
 * and the dearest that the hero is not already showing (`exclude` holds the hero's product ids). A
 * rail with nothing in it is left out.
 */
export function deriveHomeRails(
  products: readonly ProductResponse[],
  exclude: ReadonlySet<string> = new Set(),
): HomeRailData[] {
  const { pocketChangeCount, bigFlexCount } = HOME_CONFIG.rails;
  const sorted = products.filter((product) => product.available).sort(byPriceAscending);
  const rails: HomeRailData[] = [
    {
      key: "pocket-change",
      title: "Lowest prices.",
      lead: "Start small.",
      products: sorted.slice(0, pocketChangeCount),
    },
    {
      key: "big-flex",
      title: "Premium picks.",
      lead: "More from the top of the range.",
      products: sorted
        .filter((product) => !exclude.has(product.id))
        .slice(-bigFlexCount)
        .reverse(),
    },
  ];
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
